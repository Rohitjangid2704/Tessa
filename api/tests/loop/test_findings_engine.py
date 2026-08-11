import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from tessa_api.db.models import (
    FindingOccurrenceRow,
    FindingRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
)
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    FindingClass,
    FindingStatus,
    RunScenarioStatus,
    Severity,
)
from tessa_api.schemas.temporal import DedupeMatch, FindingCandidate, UpsertDecision
from tessa_api.services.findings.resolution import (
    SKIP_FAMILY_KEY,
    SKIP_INTERFACE_KEY,
    resolve_findings_after_run,
)
from tessa_api.services.findings.upsert import UpsertOutcome, upsert_decisions
from tests.loop.support import AcceptedScenarios, accepted_scenarios
from tests.stage_two.run_support import start_run
from tests.stage_two.support import OPEN_ISSUES, SeededTarget, seed_gracie

pytestmark = pytest.mark.integration

MatchKind = Literal["exact", "semantic", "uncertain", "new"]


@dataclass(frozen=True)
class Lab:
    first_run: uuid.UUID
    scenarios: AcceptedScenarios
    target_id: uuid.UUID


async def new_run(
    client: httpx.AsyncClient, headers: dict[str, str], seeded: SeededTarget
) -> uuid.UUID:
    handle = await start_run(client, headers, seeded, key=f"run-{uuid.uuid4()}")
    return uuid.UUID(handle["run_id"])


@pytest.fixture
async def lab(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
) -> Lab:
    scenarios = await accepted_scenarios(db_app, client, member_headers, seeded)
    first = await new_run(client, member_headers, seeded)
    return Lab(first, scenarios, uuid.UUID(seeded.target_id))


def candidate(
    fingerprint: str = "fp-open-issues",
    run_scenario_id: uuid.UUID | None = None,
    attempt: int | None = None,
    embedding: list[float] | None = None,
    finding_class: FindingClass = FindingClass.wrong_result,
) -> FindingCandidate:
    return FindingCandidate(
        fingerprint=fingerprint,
        finding_class=finding_class,
        severity=Severity.high,
        title="Open issue count is wrong",
        invariant_id=None,
        scenario_id=None,
        run_scenario_id=run_scenario_id,
        step_id=None,
        attempt=attempt,
        feature_id=OPEN_ISSUES,
        interface_id="chat_sse",
        role="staff",
        family=None,
        signal="expected <n> open issues",
        embedding_text="Open issue count is wrong",
        evidence={"oracle": "open_maintenance"},
        expected=4,
        actual=3,
        embedding=embedding,
    )


def decision(
    found: FindingCandidate, kind: MatchKind = "new", finding_id: uuid.UUID | None = None
) -> UpsertDecision:
    return UpsertDecision(
        candidate=found,
        match=DedupeMatch(
            fingerprint=found.fingerprint,
            kind=kind,
            finding_id=finding_id,
            similarity=None,
            possible_duplicate_of=None,
        ),
    )


async def upsert(app: FastAPI, run_id: uuid.UUID, *decisions: UpsertDecision) -> UpsertOutcome:
    async with app.state.session_factory() as session:
        outcome = await upsert_decisions(session, run_id, list(decisions))
        await session.commit()
        return outcome


async def finding_row(app: FastAPI, finding_id: uuid.UUID) -> FindingRow:
    async with app.state.session_factory() as session:
        row: FindingRow | None = await session.get(FindingRow, finding_id)
        assert row is not None
        return row


async def set_finding(app: FastAPI, finding_id: uuid.UUID, **values: Any) -> None:
    async with app.state.session_factory() as session:
        row = await session.get(FindingRow, finding_id)
        assert row is not None
        for name, value in values.items():
            setattr(row, name, value)
        await session.commit()


async def count_findings(app: FastAPI) -> int:
    async with app.state.session_factory() as session:
        return int(await session.scalar(select(func.count()).select_from(FindingRow)) or 0)


def event_types(outcome: UpsertOutcome) -> list[str]:
    return [event.type for event in outcome.events]


async def test_a_new_candidate_creates_a_finding_with_one_occurrence(
    db_app: FastAPI, lab: Lab
) -> None:
    outcome = await upsert(db_app, lab.first_run, decision(candidate()))
    assert len(outcome.created_ids) == 1
    assert outcome.updated_ids == ()
    assert outcome.occurrences_added == 1
    assert outcome.needs_repro == outcome.created_ids
    assert event_types(outcome) == ["finding.created"]
    row = await finding_row(db_app, outcome.created_ids[0])
    assert (row.status, row.class_, row.severity) == (
        FindingStatus.new,
        FindingClass.wrong_result,
        Severity.high,
    )
    assert row.target_id == lab.target_id
    assert row.first_seen_run_id == row.last_seen_run_id == lab.first_run
    assert row.occurrence_count == 1


async def test_the_same_fingerprint_in_a_later_run_adds_an_occurrence_not_a_finding(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    created = (await upsert(db_app, lab.first_run, decision(candidate()))).created_ids[0]
    second_run = await new_run(client, member_headers, seeded)
    outcome = await upsert(db_app, second_run, decision(candidate(), "exact", created))
    assert outcome.created_ids == ()
    assert outcome.updated_ids == (created,)
    assert "finding.occurrence_added" in event_types(outcome)
    row = await finding_row(db_app, created)
    assert row.occurrence_count == 2
    assert row.last_seen_run_id == second_run
    assert row.first_seen_run_id == lab.first_run
    assert await count_findings(db_app) == 1


async def test_the_fingerprint_finds_the_finding_when_the_match_names_none(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    created = (await upsert(db_app, lab.first_run, decision(candidate()))).created_ids[0]
    second_run = await new_run(client, member_headers, seeded)
    outcome = await upsert(db_app, second_run, decision(candidate(), "new"))
    assert outcome.updated_ids == (created,)
    assert await count_findings(db_app) == 1


async def test_the_same_occurrence_twice_is_counted_once(db_app: FastAPI, lab: Lab) -> None:
    first = await upsert(db_app, lab.first_run, decision(candidate(attempt=0)))
    again = await upsert(
        db_app, lab.first_run, decision(candidate(attempt=0), "exact", first.created_ids[0])
    )
    assert again.occurrences_added == 1
    assert "finding.occurrence_added" not in event_types(again)
    assert (await finding_row(db_app, first.created_ids[0])).occurrence_count == 1
    other_attempt = await upsert(
        db_app, lab.first_run, decision(candidate(attempt=1), "exact", first.created_ids[0])
    )
    assert other_attempt.occurrences_added == 1
    assert (await finding_row(db_app, first.created_ids[0])).occurrence_count == 2


async def test_two_candidates_of_one_batch_with_one_fingerprint_make_one_finding(
    db_app: FastAPI, lab: Lab
) -> None:
    outcome = await upsert(
        db_app,
        lab.first_run,
        decision(candidate(attempt=0)),
        decision(candidate(attempt=1)),
    )
    assert len(outcome.created_ids) == 1
    assert outcome.occurrences_added == 2
    assert (await finding_row(db_app, outcome.created_ids[0])).occurrence_count == 2


@pytest.mark.parametrize(
    ("before", "after"),
    [
        (FindingStatus.resolved, FindingStatus.new),
        (FindingStatus.verifying, FindingStatus.in_fix),
    ],
)
async def test_a_recurrence_reopens_the_finding(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
    before: FindingStatus,
    after: FindingStatus,
) -> None:
    created = (await upsert(db_app, lab.first_run, decision(candidate()))).created_ids[0]
    await set_finding(db_app, created, status=before, repro={"schema_version": 1})
    second_run = await new_run(client, member_headers, seeded)
    outcome = await upsert(db_app, second_run, decision(candidate(), "exact", created))
    row = await finding_row(db_app, created)
    assert row.status is after
    assert "finding.updated" in event_types(outcome)
    updated = next(event for event in outcome.events if event.type == "finding.updated")
    assert updated.payload["changes"]["status"] == {"from": before.value, "to": after.value}
    assert (created in outcome.needs_repro) is (after is FindingStatus.new)


@pytest.mark.parametrize(
    "status", [FindingStatus.known_gap, FindingStatus.dismissed, FindingStatus.triaged]
)
async def test_a_recurrence_leaves_other_statuses_alone_and_counts_known_gap_hits(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
    status: FindingStatus,
) -> None:
    created = (await upsert(db_app, lab.first_run, decision(candidate()))).created_ids[0]
    await set_finding(db_app, created, status=status, repro={"schema_version": 1})
    second_run = await new_run(client, member_headers, seeded)
    outcome = await upsert(db_app, second_run, decision(candidate(), "exact", created))
    assert (await finding_row(db_app, created)).status is status
    assert outcome.known_gap_hits == (1 if status is FindingStatus.known_gap else 0)
    assert outcome.needs_repro == ()


async def test_a_match_on_a_finding_of_another_target_is_not_followed(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    lab: Lab,
) -> None:
    other = await seed_gracie(client, member_headers, name="Other")
    other_run = await new_run(client, member_headers, other)
    foreign = (await upsert(db_app, other_run, decision(candidate()))).created_ids[0]
    outcome = await upsert(db_app, lab.first_run, decision(candidate(), "semantic", foreign))
    assert len(outcome.created_ids) == 1
    assert outcome.created_ids[0] != foreign
    assert (await finding_row(db_app, foreign)).occurrence_count == 1


async def test_only_an_embedding_of_the_right_size_is_stored(db_app: FastAPI, lab: Lab) -> None:
    short = await upsert(
        db_app, lab.first_run, decision(candidate("fp-short", embedding=[0.1] * 3))
    )
    assert (await finding_row(db_app, short.created_ids[0])).embedding is None
    full = await upsert(
        db_app, lab.first_run, decision(candidate("fp-full", embedding=[0.1] * 1536))
    )
    stored = (await finding_row(db_app, full.created_ids[0])).embedding
    assert stored is not None
    assert len(stored) == 1536


async def add_run_scenario(
    app: FastAPI,
    run_id: uuid.UUID,
    scenario_id: uuid.UUID,
    verdict_status: str,
    role: str = "staff",
    interface_id: str = "chat_sse",
    status: RunScenarioStatus = RunScenarioStatus.finished,
) -> uuid.UUID:
    async with app.state.session_factory() as session:
        scenario = await session.get(ScenarioRow, scenario_id)
        assert scenario is not None
        row = RunScenarioRow(
            id=new_id(),
            run_id=run_id,
            scenario_id=scenario_id,
            scenario_version=scenario.version,
            role=role,
            interface_id=interface_id,
            attempts_total=1,
            status=status,
            verdict={
                "status": verdict_status,
                "tier": "code",
                "confidence": None,
                "reason_code": None,
                "reason": None,
                "skip_reason": "precondition_failed" if verdict_status == "skipped" else None,
            },
        )
        session.add(row)
        await session.commit()
        return row.id


async def verifying_finding(app: FastAPI, lab: Lab, **values: Any) -> uuid.UUID:
    failing = await add_run_scenario(app, lab.first_run, lab.scenarios.chat, "fail")
    created = (
        await upsert(app, lab.first_run, decision(candidate(run_scenario_id=failing, attempt=0)))
    ).created_ids[0]
    long_ago = datetime.now(UTC) - timedelta(days=1)
    await set_finding(
        app, created, status=FindingStatus.verifying, status_changed_at=long_ago, **values
    )
    return created


async def resolve(app: FastAPI, run_id: uuid.UUID) -> list[uuid.UUID]:
    async with app.state.session_factory() as session:
        resolutions = await resolve_findings_after_run(session, run_id)
        await session.commit()
        return [item.finding_id for item in resolutions]


async def test_a_passing_rerun_resolves_a_verifying_finding(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    assert await resolve(db_app, rerun) == [finding_id]
    row = await finding_row(db_app, finding_id)
    assert row.status is FindingStatus.resolved
    assert row.status_changed_at > datetime.now(UTC) - timedelta(minutes=5)


@pytest.mark.parametrize("verdict_status", ["fail", "uncertain", "flaky", "skipped"])
async def test_a_rerun_that_does_not_pass_leaves_the_finding_verifying(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
    verdict_status: str,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, verdict_status)
    assert await resolve(db_app, rerun) == []
    assert (await finding_row(db_app, finding_id)).status is FindingStatus.verifying


async def test_a_rerun_of_other_scenarios_or_roles_resolves_nothing(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.browser, "pass", interface_id="browser")
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass", role="manager")
    assert await resolve(db_app, rerun) == []
    assert (await finding_row(db_app, finding_id)).status is FindingStatus.verifying


async def test_one_failing_key_of_the_finding_keeps_it_open(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    browser_failing = await add_run_scenario(
        db_app, lab.first_run, lab.scenarios.browser, "fail", interface_id="browser"
    )
    await upsert(
        db_app,
        lab.first_run,
        decision(candidate(run_scenario_id=browser_failing, attempt=0), "exact", finding_id),
    )
    await set_finding(
        db_app,
        finding_id,
        status=FindingStatus.verifying,
        status_changed_at=datetime.now(UTC) - timedelta(days=1),
    )
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    await add_run_scenario(db_app, rerun, lab.scenarios.browser, "fail", interface_id="browser")
    assert await resolve(db_app, rerun) == []


async def test_a_finding_moved_to_verifying_after_the_run_began_is_not_resolved_by_it(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    await set_finding(
        db_app, finding_id, status_changed_at=datetime.now(UTC) + timedelta(seconds=5)
    )
    assert await resolve(db_app, rerun) == []


async def test_a_finding_that_recurred_in_the_run_is_not_resolved_by_it(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    async with db_app.state.session_factory() as session:
        session.add(FindingOccurrenceRow(id=new_id(), finding_id=finding_id, run_id=rerun))
        await session.commit()
    assert await resolve(db_app, rerun) == []


@pytest.mark.parametrize("status", [FindingStatus.in_fix, FindingStatus.triaged])
async def test_only_a_verifying_finding_is_resolved_by_a_rerun(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
    status: FindingStatus,
) -> None:
    finding_id = await verifying_finding(db_app, lab)
    await set_finding(db_app, finding_id, status=status)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    assert await resolve(db_app, rerun) == []
    assert (await finding_row(db_app, finding_id)).status is status


async def test_a_passing_promoted_scenario_resolves_the_finding(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    finding_id = await verifying_finding(db_app, lab, promoted_scenario_id=lab.scenarios.admin_api)
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(
        db_app, rerun, lab.scenarios.admin_api, "pass", role="admin", interface_id="admin_api"
    )
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "pass")
    assert await resolve(db_app, rerun) == [finding_id]


async def test_a_skipped_family_finding_is_resolved_once_the_family_runs(
    client: httpx.AsyncClient,
    member_headers: dict[str, str],
    db_app: FastAPI,
    seeded: SeededTarget,
    lab: Lab,
) -> None:
    async with db_app.state.session_factory() as session:
        family = await session.scalar(
            select(ScenarioRow.family).where(ScenarioRow.id == lab.scenarios.chat)
        )
    assert family is not None
    harness = candidate("fp-skipped-family", finding_class=FindingClass.harness)
    harness = harness.model_copy(
        update={"evidence": {SKIP_FAMILY_KEY: family, SKIP_INTERFACE_KEY: "chat_sse"}}
    )
    finding_id = (await upsert(db_app, lab.first_run, decision(harness))).created_ids[0]
    quiet = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, quiet, lab.scenarios.browser, "pass", interface_id="browser")
    assert await resolve(db_app, quiet) == []
    rerun = await new_run(client, member_headers, seeded)
    await add_run_scenario(db_app, rerun, lab.scenarios.chat, "fail")
    assert await resolve(db_app, rerun) == [finding_id]
    assert (await finding_row(db_app, finding_id)).status is FindingStatus.resolved


async def test_resolution_of_an_unknown_run_does_nothing(db_app: FastAPI, lab: Lab) -> None:
    assert await resolve(db_app, uuid.uuid4()) == []
    async with db_app.state.session_factory() as session:
        assert await session.get(RunRow, lab.first_run) is not None
