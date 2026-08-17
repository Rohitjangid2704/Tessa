import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import pytest
import yaml
from sqlalchemy import select
from temporalio.testing import ActivityEnvironment

from tessa_api.db.models import (
    BundleRow,
    EnvironmentRow,
    OracleResultRow,
    OracleTemplateRow,
    ScenarioRow,
)
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import (
    AdapterKind,
    EnvVarKind,
    OracleApproval,
    OracleLanguage,
    OracleResultStatus,
    RunScenarioStatus,
    VerdictStatus,
)
from tessa_api.schemas.scenario import ScenarioDoc
from tessa_api.schemas.steps import SseEvent, SseStepRequest, SseStepResponse
from tessa_api.schemas.temporal import AttemptResult, DriveAttemptInput
from tessa_api.services.artifact_store import InMemoryArtifactStore
from tessa_api.services.vault import vault_from_settings
from tessa_api.settings import Settings
from tessa_worker.activities.drive import DriveActivities
from tessa_worker.activities.truth_hooks import default_truth_hooks
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.tier0 import evaluate_tier0
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.truth_verdicts import (
    DB_MATCHED,
    DB_MISMATCH,
    ORACLE_NOT_APPROVED,
    ORACLE_NOT_FOUND,
)
from tests.runs.drive_support import FakeAdapter, FakeOpener
from tests.runs.support import SeededRun, load_steps, seed_run
from tests.support import REPO_ROOT

pytestmark = pytest.mark.integration

ORACLE = "open_count"
ASK = "How many maintenance issues are open?"
TRUTH_MANIFEST = REPO_ROOT / "deploy" / "postgres" / "truth-fixture" / "tessa" / "manifest.yaml"
COUNT_QUERY = "SELECT 3 AS open_count"


def chat_step(
    label: str,
    text_contains: Sequence[str] = (),
    gold_from: bool = False,
    expect_db: dict[str, Any] | None = None,
    oracle: str = ORACLE,
) -> dict[str, Any]:
    step: dict[str, Any] = {
        "adapter": "sse",
        "label": label,
        "ask": ASK,
        "request": {"method": "POST", "path": "/api/chat/stream", "body": {"message": ASK}},
        "expect": {"status": 200, "text_contains": list(text_contains)},
    }
    if gold_from:
        step["gold_from"] = {"oracle": oracle}
    if expect_db is not None:
        step["expect_db"] = {"oracle": oracle, "expect": expect_db}
    return step


def chat_record(answer: str) -> StepRecord:
    moment = datetime.now(UTC)
    return StepRecord(
        adapter=AdapterKind.sse,
        label="ask",
        request=SseStepRequest(
            kind="sse",
            method="POST",
            url="http://target.test/api/chat/stream",
            headers={},
            query=None,
            body={"message": ASK},
        ),
        response=SseStepResponse(
            kind="sse",
            status=200,
            events=[SseEvent(event=None, data=answer, at_ms=5)],
            closed_by="server",
        ),
        ok=True,
        ask=ASK,
        answer=answer,
        latency_ms=20,
        started_at=moment,
        finished_at=moment,
    )


def truth_dsn(api_settings: Settings) -> str:
    return api_settings.database_url.get_secret_value().replace("+asyncpg", "")


async def prepare_truth(
    session_factory: SessionFactory,
    seeded: SeededRun,
    settings: WorkerSettings,
    api_settings: Settings,
    steps: Sequence[dict[str, Any]],
    approval: OracleApproval = OracleApproval.approved,
) -> None:
    document = ScenarioDoc.model_validate(
        {
            "schema_version": 1,
            "title": "Open issues from the truth database",
            "feature_id": "maintenance.read.open_issues",
            "family": "maintenance",
            "role": "staff",
            "interface_id": "chat_sse",
            "steps": list(steps),
        }
    ).model_dump(mode="json", by_alias=True)
    async with session_factory() as session:
        bundle = await session.get(BundleRow, seeded.bundle_id)
        scenario = await session.get(ScenarioRow, seeded.scenario_ids[0])
        assert bundle is not None
        assert scenario is not None
        bundle.manifest = yaml.safe_load(TRUTH_MANIFEST.read_text(encoding="utf-8"))
        scenario.parsed = document
        scenario.yaml = json.dumps(document)
        session.add(
            EnvironmentRow(
                target_id=seeded.target_id,
                name="TRUTH_DB_DSN",
                kind=EnvVarKind.dsn,
                secret=True,
                encrypted_value=vault_from_settings(settings).encrypt(truth_dsn(api_settings)),
            )
        )
        session.add(
            OracleTemplateRow(
                bundle_id=seeded.bundle_id,
                target_id=seeded.target_id,
                name=ORACLE,
                feature_ids=["maintenance.read.open_issues"],
                language=OracleLanguage.sql,
                source=COUNT_QUERY,
                params_schema={"type": "object", "properties": {}},
                sentence_template="{{ rows[0].open_count }} open issues",
                read_only_verified=True,
                approval=approval,
                truth_source="primary_db",
                gold_points=[
                    {
                        "key": "open_count",
                        "expression": "rows[0].open_count",
                        "template": "{{ value }} open issues",
                    }
                ],
            )
        )
        await session.commit()


async def drive(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
    answers: Sequence[str],
) -> tuple[AttemptResult, FakeAdapter]:
    adapter = FakeAdapter(kind=AdapterKind.sse, records=[chat_record(text) for text in answers])
    activities = DriveActivities(
        settings,
        session_factory,
        event_client,
        FakeOpener(adapter=adapter),
        InMemoryArtifactStore(),
        evaluate_tier0,
        default_truth_hooks(settings, session_factory),
    )
    request = DriveAttemptInput(
        run_id=seeded.run_id,
        run_scenario_id=seeded.run_scenario_ids[0],
        attempt=0,
        read_only=False,
    )
    result: AttemptResult = await ActivityEnvironment().run(
        activities.drive_scenario_attempt, request
    )
    return result, adapter


async def oracle_results(session_factory: SessionFactory) -> list[OracleResultRow]:
    async with session_factory() as session:
        return list(await session.scalars(select(OracleResultRow)))


@pytest.fixture
async def seeded(session_factory: SessionFactory) -> SeededRun:
    return await seed_run(session_factory, scenario_count=1)


async def test_gold_points_come_from_the_oracle_and_an_answer_stating_them_passes(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
) -> None:
    steps = [chat_step("ask", ["${gold.open_count}"], gold_from=True)]
    await prepare_truth(session_factory, seeded, worker_settings, api_settings, steps)
    result, _ = await drive(
        worker_settings, session_factory, event_client, seeded, ["There are 3 open issues."]
    )
    assert result.status is RunScenarioStatus.finished
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.pass_
    [step] = await load_steps(session_factory, seeded.run_id)
    assert [(point["key"], point["value"], point["rendered"]) for point in step.gold_points] == [
        ("open_count", 3, "3 open issues")
    ]
    assert step.tier0["passed"] is True
    [oracle_result] = await oracle_results(session_factory)
    assert oracle_result.status is OracleResultStatus.ok
    assert oracle_result.rows == [{"open_count": 3}]
    assert oracle_result.run_id == seeded.run_id


async def test_an_answer_that_misses_the_oracle_count_fails_tier0(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
) -> None:
    steps = [chat_step("ask", ["${gold.open_count}"], gold_from=True)]
    await prepare_truth(session_factory, seeded, worker_settings, api_settings, steps)
    result, _ = await drive(
        worker_settings, session_factory, event_client, seeded, ["There are 5 open issues."]
    )
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.fail
    [step] = await load_steps(session_factory, seeded.run_id)
    assert step.tier0["passed"] is False
    assert step.tier0_failure_count == 1
    assert "3 open issues" in json.dumps(step.tier0["failures"])


async def test_a_later_step_is_checked_against_the_gold_point_of_an_earlier_step(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
) -> None:
    steps = [chat_step("count", gold_from=True), chat_step("repeat", ["${gold.open_count}"])]
    await prepare_truth(session_factory, seeded, worker_settings, api_settings, steps)
    result, adapter = await drive(
        worker_settings,
        session_factory,
        event_client,
        seeded,
        ["Some issues are open.", "To repeat: 4 open issues."],
    )
    assert len(adapter.driven) == 2
    assert result.verdict is not None
    assert result.verdict.status is VerdictStatus.fail
    first, second = await load_steps(session_factory, seeded.run_id)
    assert first.tier0["passed"] is True
    assert second.tier0["passed"] is False
    assert len(await oracle_results(session_factory)) == 1


@pytest.mark.parametrize(
    ("expected", "status", "reason_code"),
    [(3, VerdictStatus.pass_, DB_MATCHED), (4, VerdictStatus.fail, DB_MISMATCH)],
)
async def test_expect_db_compares_the_oracle_rows_after_the_step(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
    expected: int,
    status: VerdictStatus,
    reason_code: str,
) -> None:
    steps = [chat_step("ask", expect_db={"first_row": {"open_count": expected}})]
    await prepare_truth(session_factory, seeded, worker_settings, api_settings, steps)
    result, _ = await drive(
        worker_settings, session_factory, event_client, seeded, ["Done looking."]
    )
    assert result.verdict is not None
    assert result.verdict.status is status
    [step] = await load_steps(session_factory, seeded.run_id)
    assert step.db_checks
    assert {check["status"] for check in step.db_checks} == {status.value}
    assert {check["actual"] for check in step.db_checks} == {3}
    if status is VerdictStatus.fail:
        assert step.verdict is not None
        assert step.verdict["reason_code"] == reason_code


async def test_an_unapproved_oracle_halts_the_attempt_before_the_step_is_driven(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
) -> None:
    steps = [chat_step("ask", ["${gold.open_count}"], gold_from=True)]
    await prepare_truth(
        session_factory,
        seeded,
        worker_settings,
        api_settings,
        steps,
        approval=OracleApproval.unreviewed,
    )
    result, adapter = await drive(
        worker_settings, session_factory, event_client, seeded, ["There are 3 open issues."]
    )
    assert adapter.driven == []
    assert result.verdict is not None
    assert result.verdict.status is not VerdictStatus.pass_
    assert result.verdict.reason_code == ORACLE_NOT_APPROVED
    assert await oracle_results(session_factory) == []


async def test_an_unknown_oracle_halts_the_attempt_and_names_the_oracle(
    worker_settings: WorkerSettings,
    api_settings: Settings,
    session_factory: SessionFactory,
    event_client: EventClient,
    seeded: SeededRun,
) -> None:
    steps = [chat_step("ask", gold_from=True, oracle="missing_oracle")]
    await prepare_truth(session_factory, seeded, worker_settings, api_settings, steps)
    result, adapter = await drive(
        worker_settings, session_factory, event_client, seeded, ["There are 3 open issues."]
    )
    assert adapter.driven == []
    assert result.verdict is not None
    assert result.verdict.status is not VerdictStatus.pass_
    assert result.verdict.reason_code == ORACLE_NOT_FOUND
    assert result.verdict.reason is not None
    assert "missing_oracle" in result.verdict.reason
