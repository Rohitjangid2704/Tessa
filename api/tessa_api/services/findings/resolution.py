import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    FindingOccurrenceRow,
    FindingRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
)
from tessa_api.schemas.enums import (
    FindingClass,
    FindingStatus,
    RunScenarioStatus,
    VerdictStatus,
)
from tessa_api.services.findings.candidates import parsed_verdict
from tessa_api.services.findings.lifecycle import OPEN_STATUSES, Changes, move_to

SKIP_FAMILY_KEY = "skip_family"
SKIP_INTERFACE_KEY = "skip_interface"

ScenarioKey = tuple[uuid.UUID, str, str]
FamilyKey = tuple[str, str]


@dataclass(frozen=True, slots=True)
class Resolution:
    finding_id: uuid.UUID
    changes: Changes


@dataclass(frozen=True, slots=True)
class ExecutedWork:
    verdicts_by_key: Mapping[ScenarioKey, VerdictStatus]
    verdicts_by_scenario: Mapping[uuid.UUID, tuple[VerdictStatus, ...]]
    families: frozenset[FamilyKey]


@dataclass(slots=True)
class WorkBuilder:
    verdicts_by_key: dict[ScenarioKey, VerdictStatus] = field(default_factory=dict)
    verdicts_by_scenario: dict[uuid.UUID, list[VerdictStatus]] = field(
        default_factory=lambda: defaultdict(list)
    )
    families: set[FamilyKey] = field(default_factory=set)


def executed_status(status: RunScenarioStatus, verdict: VerdictStatus | None) -> bool:
    return (
        status is RunScenarioStatus.finished
        and verdict is not None
        and verdict is not VerdictStatus.skipped
    )


async def load_executed_work(session: AsyncSession, run_id: uuid.UUID) -> ExecutedWork:
    rows = await session.execute(
        select(RunScenarioRow, ScenarioRow.family)
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(RunScenarioRow.run_id == run_id)
    )
    builder = WorkBuilder()
    for run_scenario, family in rows:
        verdict = parsed_verdict(run_scenario.verdict)
        status = None if verdict is None else verdict.status
        if not executed_status(run_scenario.status, status) or status is None:
            continue
        key = (run_scenario.scenario_id, run_scenario.role, run_scenario.interface_id)
        builder.verdicts_by_key[key] = status
        builder.verdicts_by_scenario[run_scenario.scenario_id].append(status)
        builder.families.add((family, run_scenario.interface_id))
    return ExecutedWork(
        verdicts_by_key=builder.verdicts_by_key,
        verdicts_by_scenario={
            scenario_id: tuple(statuses)
            for scenario_id, statuses in builder.verdicts_by_scenario.items()
        },
        families=frozenset(builder.families),
    )


async def verifying_findings(
    session: AsyncSession, run: RunRow, target_id: uuid.UUID
) -> Sequence[FindingRow]:
    rows = await session.scalars(
        select(FindingRow)
        .where(
            FindingRow.target_id == target_id,
            FindingRow.status == FindingStatus.verifying,
            FindingRow.status_changed_at < run.created_at,
            ~exists().where(
                FindingOccurrenceRow.finding_id == FindingRow.id,
                FindingOccurrenceRow.run_id == run.id,
            ),
        )
        .order_by(FindingRow.id)
        .with_for_update()
    )
    return rows.all()


async def occurrence_keys(session: AsyncSession, finding_id: uuid.UUID) -> frozenset[ScenarioKey]:
    rows = await session.execute(
        select(RunScenarioRow.scenario_id, RunScenarioRow.role, RunScenarioRow.interface_id)
        .join(FindingOccurrenceRow, FindingOccurrenceRow.run_scenario_id == RunScenarioRow.id)
        .where(FindingOccurrenceRow.finding_id == finding_id)
        .distinct()
    )
    return frozenset((scenario_id, role, interface_id) for scenario_id, role, interface_id in rows)


def rerun_statuses(
    row: FindingRow, keys: frozenset[ScenarioKey], work: ExecutedWork
) -> list[VerdictStatus]:
    statuses = [work.verdicts_by_key[key] for key in keys if key in work.verdicts_by_key]
    if row.promoted_scenario_id is not None:
        statuses.extend(work.verdicts_by_scenario.get(row.promoted_scenario_id, ()))
    return statuses


async def verified_by_rerun(session: AsyncSession, row: FindingRow, work: ExecutedWork) -> bool:
    statuses = rerun_statuses(row, await occurrence_keys(session, row.id), work)
    return bool(statuses) and all(status is VerdictStatus.pass_ for status in statuses)


async def skipped_harness_findings(
    session: AsyncSession, run: RunRow, target_id: uuid.UUID
) -> Sequence[FindingRow]:
    rows = await session.scalars(
        select(FindingRow)
        .where(
            FindingRow.target_id == target_id,
            FindingRow.class_ == FindingClass.harness,
            FindingRow.status.in_(sorted(OPEN_STATUSES, key=lambda status: status.value)),
            ~exists().where(
                FindingOccurrenceRow.finding_id == FindingRow.id,
                FindingOccurrenceRow.run_id == run.id,
            ),
        )
        .order_by(FindingRow.id)
        .with_for_update()
    )
    return rows.all()


async def skipped_family_of(session: AsyncSession, finding_id: uuid.UUID) -> FamilyKey | None:
    evidence = await session.scalar(
        select(FindingOccurrenceRow.evidence)
        .where(FindingOccurrenceRow.finding_id == finding_id)
        .order_by(FindingOccurrenceRow.seen_at.desc())
        .limit(1)
    )
    if evidence is None:
        return None
    family = evidence.get(SKIP_FAMILY_KEY)
    interface_id = evidence.get(SKIP_INTERFACE_KEY)
    if isinstance(family, str) and isinstance(interface_id, str):
        return family, interface_id
    return None


def mark_resolved(row: FindingRow) -> Resolution:
    changes: Changes = {"status": (row.status.value, FindingStatus.resolved.value)}
    move_to(row, FindingStatus.resolved)
    return Resolution(finding_id=row.id, changes=changes)


async def resolve_findings_after_run(session: AsyncSession, run_id: uuid.UUID) -> list[Resolution]:
    run = await session.get(RunRow, run_id)
    if run is None or run.target_id is None:
        return []
    work = await load_executed_work(session, run_id)
    resolutions: list[Resolution] = []
    resolved: set[uuid.UUID] = set()
    for row in await verifying_findings(session, run, run.target_id):
        if await verified_by_rerun(session, row, work):
            resolutions.append(mark_resolved(row))
            resolved.add(row.id)
    for row in await skipped_harness_findings(session, run, run.target_id):
        if row.id in resolved:
            continue
        family = await skipped_family_of(session, row.id)
        if family is not None and family in work.families:
            resolutions.append(mark_resolved(row))
    await session.flush()
    return resolutions
