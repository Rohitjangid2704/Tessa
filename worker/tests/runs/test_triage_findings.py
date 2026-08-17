import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import func, select
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment, WorkflowEnvironment
from temporalio.worker import Worker

from tessa_api.db.models import (
    BundleRow,
    FindingOccurrenceRow,
    FindingRow,
    ModelCallRow,
    RunRow,
    RunScenarioRow,
    StepRow,
)
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import (
    AdapterKind,
    DedupeMode,
    FindingStatus,
    RunScenarioStatus,
    RunStatus,
    Tier0Check,
)
from tessa_api.schemas.model_calls import EmbedCallSpec
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_api.schemas.temporal import (
    TRIAGE_FINDINGS_WORKFLOW,
    EmbedTextsInput,
    TriageFindingsInput,
    TriageFindingsResult,
)
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.storage import LocalBundleStore
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.embed import EmbedActivities
from tessa_worker.activities.model_call import DatabaseModelCallRecorder
from tessa_worker.findings.embedding_client import KeyedEmbeddingProviders
from tessa_worker.grading.errors import GradingErrorType
from tessa_worker.grading.judge_providers import ProviderKeys
from tessa_worker.main import WorkerServices, build_activities
from tessa_worker.settings import WorkerSettings
from tessa_worker.verdicts import fail_verdict, pass_verdict
from tessa_worker.workflows.triage_findings import TriageFindingsWorkflow
from tests.runs.drive_support import FakeOpener
from tests.runs.support import RecordingIngest, SeededRun, new_run_row, seed_run
from tests.support import TEST_LAYA_URL

pytestmark = pytest.mark.integration

TASK_QUEUE = "tessa-test-worker-triage"
UNREACHABLE_LAYA = TEST_LAYA_URL
ROLE = "staff"
INTERFACE = "chat-1"


def triage_settings(worker_settings: WorkerSettings) -> WorkerSettings:
    return worker_settings.model_copy(
        update={"stub_models": True, "laya_url": UNREACHABLE_LAYA, "laya_timeout_seconds": 1}
    )


async def record_run(
    session_factory: SessionFactory, seeded: SeededRun, failing: bool
) -> uuid.UUID:
    async with session_factory() as session:
        bundle = await session.get(BundleRow, seeded.bundle_id)
        assert bundle is not None
        run = new_run_row(
            seeded.target_id,
            seeded.plan_id,
            seeded.bundle_id,
            bundle.hash,
            seeded.user_id,
            status=RunStatus.running,
        )
        session.add(run)
        await session.flush()
        verdict = fail_verdict("status 500, expected 200") if failing else pass_verdict()
        run_scenario = RunScenarioRow(
            run_id=run.id,
            scenario_id=seeded.scenario_ids[0],
            scenario_version=1,
            role=ROLE,
            interface_id=INTERFACE,
            attempts_total=1,
            status=RunScenarioStatus.finished,
            attempts=[
                {"attempt": 0, "status": "finished", "verdict": verdict.model_dump(mode="json")}
            ],
            verdict=verdict.model_dump(mode="json"),
        )
        session.add(run_scenario)
        await session.flush()
        failures = (
            [
                Tier0Failure(
                    check=Tier0Check.status,
                    message="expected status 200, got 500",
                    expected=200,
                    actual=500,
                )
            ]
            if failing
            else []
        )
        now = datetime.now(UTC).replace(tzinfo=None)
        session.add(
            StepRow(
                run_scenario_id=run_scenario.id,
                run_id=run.id,
                attempt=0,
                index=0,
                adapter=AdapterKind.http,
                label="list items",
                request={
                    "kind": "http",
                    "method": "GET",
                    "url": "http://target.test/api/items",
                    "headers": {},
                    "query": None,
                    "body": None,
                },
                response={
                    "kind": "http",
                    "status": 500 if failing else 200,
                    "headers": {},
                    "body": None,
                    "body_text": "boom" if failing else "[]",
                },
                ok=True,
                tier0=Tier0Result(passed=not failing, failures=failures).model_dump(mode="json"),
                tier0_failure_count=len(failures),
                verdict=verdict.model_dump(mode="json"),
                latency_ms=12,
                started_at=now,
                finished_at=now,
            )
        )
        await session.commit()
        return run.id


@asynccontextmanager
async def triage_worker(
    environment: WorkflowEnvironment,
    settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> AsyncIterator[None]:
    async with (
        httpx.AsyncClient(transport=httpx.MockTransport(ingest.handle)) as api_http,
        httpx.AsyncClient() as laya_http,
    ):
        services = WorkerServices(
            settings=settings,
            api_http=api_http,
            laya_http=laya_http,
            session_factory=session_factory,
            adapters=FakeOpener(),
            artifacts=InMemoryArtifactStore(),
            bundles=LocalBundleStore(settings.data_dir),
        )
        async with Worker(
            environment.client,
            task_queue=TASK_QUEUE,
            workflows=[TriageFindingsWorkflow],
            activities=build_activities(services),
        ):
            yield


async def triage(environment: WorkflowEnvironment, run_id: uuid.UUID) -> TriageFindingsResult:
    result: TriageFindingsResult = await environment.client.execute_workflow(
        TRIAGE_FINDINGS_WORKFLOW,
        TriageFindingsInput(run_id=run_id),
        id=f"triage-test-{uuid.uuid4()}",
        task_queue=TASK_QUEUE,
        result_type=TriageFindingsResult,
    )
    return result


async def findings_of(session_factory: SessionFactory, target_id: uuid.UUID) -> list[FindingRow]:
    async with session_factory() as session:
        rows = await session.scalars(
            select(FindingRow).where(FindingRow.target_id == target_id).order_by(FindingRow.id)
        )
        return list(rows)


async def occurrences_of(session_factory: SessionFactory, finding_id: uuid.UUID) -> int:
    async with session_factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(FindingOccurrenceRow)
            .where(FindingOccurrenceRow.finding_id == finding_id)
        )
        return int(count or 0)


async def move_to_verifying(session_factory: SessionFactory, finding_id: uuid.UUID) -> None:
    async with session_factory() as session:
        row = await session.get(FindingRow, finding_id)
        assert row is not None
        row.status = FindingStatus.verifying
        row.status_changed_at = datetime.now(UTC).replace(tzinfo=None)
        await session.commit()


async def test_a_failure_is_filed_once_seen_again_and_resolved_by_a_passing_rerun(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    settings = triage_settings(worker_settings)
    async with triage_worker(temporal_env, settings, session_factory, ingest):
        first = await triage(temporal_env, await record_run(session_factory, seeded, True))
        [finding] = await findings_of(session_factory, seeded.target_id)
        assert (first.created, first.updated) == (1, 0)
        assert first.dedupe_mode is DedupeMode.embedding
        assert finding.status is FindingStatus.new
        assert finding.repro is not None
        assert finding.embedding is not None
        assert finding.scenario_id == seeded.scenario_ids[0]
        assert await occurrences_of(session_factory, finding.id) == 1

        second_run = await record_run(session_factory, seeded, True)
        second = await triage(temporal_env, second_run)
        [seen_again] = await findings_of(session_factory, seeded.target_id)
        assert (second.created, second.updated, second.occurrences_added) == (0, 1, 1)
        assert seen_again.id == finding.id
        assert seen_again.occurrence_count == 2
        assert seen_again.last_seen_run_id == second_run

        await move_to_verifying(session_factory, finding.id)
        passing = await triage(temporal_env, await record_run(session_factory, seeded, False))
        [resolved] = await findings_of(session_factory, seeded.target_id)
        assert (passing.created, passing.updated) == (0, 0)
        assert resolved.status is FindingStatus.resolved
    assert "finding.created" in ingest.types


async def test_a_verifying_finding_whose_rerun_fails_again_is_not_resolved(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    settings = triage_settings(worker_settings)
    async with triage_worker(temporal_env, settings, session_factory, ingest):
        await triage(temporal_env, await record_run(session_factory, seeded, True))
        [finding] = await findings_of(session_factory, seeded.target_id)
        await move_to_verifying(session_factory, finding.id)
        await triage(temporal_env, await record_run(session_factory, seeded, True))
    [still_open] = await findings_of(session_factory, seeded.target_id)
    assert still_open.status is not FindingStatus.resolved


async def test_a_clean_run_files_nothing(
    temporal_env: WorkflowEnvironment,
    worker_settings: WorkerSettings,
    session_factory: SessionFactory,
    ingest: RecordingIngest,
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    settings = triage_settings(worker_settings)
    async with triage_worker(temporal_env, settings, session_factory, ingest):
        result = await triage(temporal_env, await record_run(session_factory, seeded, False))
    assert (result.created, result.updated) == (0, 0)
    assert await findings_of(session_factory, seeded.target_id) == []


def embed_spec(max_usd: float) -> EmbedCallSpec:
    return EmbedCallSpec(
        model="stub",
        dimensions=1536,
        max_usd=max_usd,
        start_to_close_timeout_seconds=30,
        max_attempts=1,
    )


async def set_budget(session_factory: SessionFactory, run_id: uuid.UUID, max_usd: float) -> None:
    async with session_factory() as session:
        row = await session.get(RunRow, run_id)
        assert row is not None
        row.budget = {"max_usd": max_usd, "max_minutes": 30}
        row.spent_usd = Decimal("0")
        await session.commit()


async def test_a_stub_embedding_call_passes_the_same_budget_pre_check_as_a_real_one(
    worker_settings: WorkerSettings, session_factory: SessionFactory
) -> None:
    seeded = await seed_run(session_factory, scenario_count=1)
    settings = triage_settings(worker_settings)
    embed = EmbedActivities(
        settings,
        DatabaseModelCallRecorder(session_factory),
        KeyedEmbeddingProviders(
            ProviderKeys(session_factory, vault_from_settings(settings), settings)
        ),
    )
    request = EmbedTextsInput(run_id=seeded.run_id, texts=["a finding"], spec=embed_spec(0.05))
    await set_budget(session_factory, seeded.run_id, 0.01)
    with pytest.raises(ApplicationError) as caught:
        await ActivityEnvironment().run(embed.embed_texts, request)
    assert caught.value.type == GradingErrorType.budget_exceeded
    await set_budget(session_factory, seeded.run_id, 5.0)
    output = await ActivityEnvironment().run(embed.embed_texts, request)
    assert output.cost_usd == 0.0
    assert len(output.vectors) == 1
    async with session_factory() as session:
        models = set(
            await session.scalars(
                select(ModelCallRow.model).where(ModelCallRow.run_id == seeded.run_id)
            )
        )
    assert models == {"stub"}
