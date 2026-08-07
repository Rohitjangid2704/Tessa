import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow
from tessa_api.schemas.enums import (
    CoverageUpdateReason,
    FindingClass,
    RunKind,
    RunScenarioStatus,
    ScenarioStatus,
    VerdictStatus,
)
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import DedupeMatch, FindingCandidate, UpsertDecision
from tessa_api.services.cell_status import settle_scenario_cells
from tessa_api.services.coverage_events import coverage_updated_events, scenario_changed_event
from tessa_api.services.findings.candidates import (
    CandidateAssembler,
    CandidateInputs,
    ScenarioContext,
    location_of,
)
from tessa_api.services.findings.classify import CHECK_FLAKY, Classification
from tessa_api.services.findings.fingerprint import normalize_signal
from tessa_api.services.findings.signals import Signal, safe_text
from tessa_api.services.findings.upsert import upsert_decisions
from tessa_api.services.flakiness import (
    RunOutcome,
    advance,
    needs_counting,
    provenance_with,
    quarantined,
    record_of,
    run_outcome,
)
from tessa_api.services.scenario_library import is_synthetic
from tessa_api.services.scenario_lifecycle import cell_key_of, keys_of
from tessa_api.services.seed_resolution import parse_stored_manifest

EXECUTED_STATUSES = (RunScenarioStatus.finished, RunScenarioStatus.errored)
QUARANTINE_REASON_CODE = "flaky_quarantined"


class RunMissingError(LookupError):
    pass


@dataclass(frozen=True, slots=True)
class QuarantinedScenario:
    row: ScenarioRow
    run_scenario: RunScenarioRow
    streak: int


@dataclass(frozen=True, slots=True)
class PolicyOutcome:
    quarantined: tuple[uuid.UUID, ...]
    finding_ids: tuple[uuid.UUID, ...]
    events: tuple[IngestEvent, ...]


NOTHING_APPLIED = PolicyOutcome(quarantined=(), finding_ids=(), events=())


def verdict_status_of(raw: Mapping[str, Any] | None) -> VerdictStatus | None:
    if raw is None or not isinstance(status := raw.get("status"), str):
        return None
    try:
        return VerdictStatus(status)
    except ValueError:
        return None


def outcome_of(group: Iterable[RunScenarioRow]) -> RunOutcome:
    return run_outcome(verdict_status_of(item.verdict) for item in group)


def flaky_run_scenario_of(group: Sequence[RunScenarioRow]) -> RunScenarioRow:
    return next(
        (item for item in group if verdict_status_of(item.verdict) is VerdictStatus.flaky),
        group[0],
    )


async def executed_run_scenarios(
    session: AsyncSession, run_id: uuid.UUID
) -> dict[uuid.UUID, list[RunScenarioRow]]:
    rows = await session.scalars(
        select(RunScenarioRow)
        .where(RunScenarioRow.run_id == run_id, RunScenarioRow.status.in_(EXECUTED_STATUSES))
        .order_by(
            RunScenarioRow.scenario_id,
            RunScenarioRow.role,
            RunScenarioRow.interface_id,
            RunScenarioRow.id,
        )
    )
    groups: defaultdict[uuid.UUID, list[RunScenarioRow]] = defaultdict(list)
    for row in rows:
        groups[row.scenario_id].append(row)
    return dict(groups)


async def load_scenarios(
    session: AsyncSession, scenario_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, ScenarioRow]:
    rows = await session.scalars(
        select(ScenarioRow).where(ScenarioRow.id.in_(list(scenario_ids))).order_by(ScenarioRow.id)
    )
    return {row.id: row for row in rows}


async def count_scenario_run(
    session: AsyncSession,
    run_id: uuid.UUID,
    scenarios: Mapping[uuid.UUID, ScenarioRow],
    scenario_id: uuid.UUID,
    group: Sequence[RunScenarioRow],
    quarantine_after: int,
    now: datetime,
) -> QuarantinedScenario | None:
    outcome = outcome_of(group)
    row = scenarios.get(scenario_id)
    if row is None or is_synthetic(row) or not needs_counting(record_of(row.provenance), outcome):
        return None
    await session.refresh(row, with_for_update=True)
    step = advance(record_of(row.provenance), run_id, outcome, quarantine_after)
    if not step.counted:
        return None
    quarantine = step.quarantine and row.status is ScenarioStatus.accepted
    record = quarantined(step.record, now) if quarantine else step.record
    row.provenance = provenance_with(row.provenance, record)
    if not quarantine:
        return None
    row.status = ScenarioStatus.quarantined
    return QuarantinedScenario(row, flaky_run_scenario_of(group), record.streak)


async def candidate_inputs(
    session: AsyncSession, run: RunRow, target_id: uuid.UUID
) -> CandidateInputs:
    bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
    manifest = None if bundle is None else parse_stored_manifest(bundle)
    return CandidateInputs(
        target_id=target_id,
        scenarios=(),
        steps=(),
        invariant_failures=(),
        violated_probes={},
        feature_kinds={}
        if manifest is None
        else {item.id: item.kind for item in manifest.features},
        role_levels={} if manifest is None else {item.id: item.level for item in manifest.roles},
    )


def quarantine_candidate(
    inputs: CandidateInputs, item: QuarantinedScenario, quarantine_after: int
) -> FindingCandidate:
    row = item.row
    scenario = ScenarioContext(
        run_scenario_id=item.run_scenario.id,
        scenario_id=row.id,
        title=row.title,
        family=row.family,
        feature_id=row.feature_id,
        role=item.run_scenario.role,
        interface_id=item.run_scenario.interface_id,
        status=item.run_scenario.status,
        skip_reason=None,
        verdict=None,
        attempts=(),
    )
    signal = Signal(
        classification=Classification(FindingClass.flaky, CHECK_FLAKY, None),
        signal=normalize_signal(f"flaky: scenario {row.title} quarantined"),
        summary=safe_text(f"Quarantined as flaky: {row.title}"),
        expected="every attempt passes",
        actual=f"flaky in {item.streak} consecutive runs",
        reason_code=QUARANTINE_REASON_CODE,
    )
    return CandidateAssembler(inputs).candidate_of(
        signal,
        location_of(scenario),
        None,
        None,
        {"quarantined": True, "flaky_streak": item.streak, "quarantine_after": quarantine_after},
    )


def new_match(candidate: FindingCandidate) -> DedupeMatch:
    return DedupeMatch(
        fingerprint=candidate.fingerprint,
        kind="new",
        finding_id=None,
        similarity=None,
        possible_duplicate_of=None,
    )


async def file_findings(
    session: AsyncSession,
    run: RunRow,
    target_id: uuid.UUID,
    items: Sequence[QuarantinedScenario],
    quarantine_after: int,
) -> tuple[list[uuid.UUID], list[IngestEvent]]:
    inputs = await candidate_inputs(session, run, target_id)
    candidates = [quarantine_candidate(inputs, item, quarantine_after) for item in items]
    decisions = [
        UpsertDecision(candidate=candidate, match=new_match(candidate)) for candidate in candidates
    ]
    outcome = await upsert_decisions(session, run.id, decisions)
    finding_ids = sorted({*outcome.created_ids, *outcome.updated_ids})
    return finding_ids, list(outcome.events)


async def apply_flakiness_policy(
    session: AsyncSession, run_id: uuid.UUID, quarantine_after: int
) -> PolicyOutcome:
    run = await session.get(RunRow, run_id)
    if run is None or run.target_id is None:
        raise RunMissingError(f"run {run_id} does not exist or has no target")
    if run.kind is not RunKind.suite:
        return NOTHING_APPLIED
    now = datetime.now(UTC)
    groups = await executed_run_scenarios(session, run_id)
    scenarios = await load_scenarios(session, groups)
    items: list[QuarantinedScenario] = []
    for scenario_id in sorted(groups):
        counted = await count_scenario_run(
            session, run_id, scenarios, scenario_id, groups[scenario_id], quarantine_after, now
        )
        if counted is not None:
            items.append(counted)
    if not items:
        return NOTHING_APPLIED
    await session.flush()
    changes = await settle_scenario_cells(
        session, run.target_id, keys_of(*(cell_key_of(item.row) for item in items))
    )
    finding_ids, finding_events = await file_findings(
        session, run, run.target_id, items, quarantine_after
    )
    events = [
        *(scenario_changed_event(item.row.id, item.row.status, item.row.cell_id) for item in items),
        *coverage_updated_events(changes, CoverageUpdateReason.run),
        *finding_events,
    ]
    return PolicyOutcome(
        quarantined=tuple(item.row.id for item in items),
        finding_ids=tuple(finding_ids),
        events=tuple(events),
    )
