import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import InvariantResultRow, RunScenarioRow
from tessa_api.schemas.enums import VerdictStatus
from tessa_api.services.mutation_scoring import (
    RunResults,
    ScenarioKey,
    ScenarioResult,
    fold_invariant_statuses,
)

EMPTY_RESULTS = RunResults(scenarios={}, invariants={})


def verdict_status_of(verdict: dict[str, Any] | None) -> VerdictStatus | None:
    if not isinstance(verdict, dict):
        return None
    status = verdict.get("status")
    if not isinstance(status, str):
        return None
    try:
        return VerdictStatus(status)
    except ValueError:
        return None


async def load_scenario_results(
    session: AsyncSession, run_id: uuid.UUID
) -> tuple[dict[uuid.UUID, ScenarioKey], dict[ScenarioKey, ScenarioResult]]:
    rows = await session.execute(
        select(
            RunScenarioRow.id,
            RunScenarioRow.scenario_id,
            RunScenarioRow.scenario_version,
            RunScenarioRow.role,
            RunScenarioRow.interface_id,
            RunScenarioRow.verdict,
        ).where(RunScenarioRow.run_id == run_id)
    )
    keys: dict[uuid.UUID, ScenarioKey] = {}
    results: dict[ScenarioKey, ScenarioResult] = {}
    for row_id, scenario_id, version, role, interface_id, verdict in rows:
        key = ScenarioKey(scenario_id, role, interface_id)
        keys[row_id] = key
        results[key] = ScenarioResult(version, verdict_status_of(verdict))
    return keys, results


async def load_run_results(session: AsyncSession, run_id: uuid.UUID) -> RunResults:
    keys, scenarios = await load_scenario_results(session, run_id)
    rows = await session.execute(
        select(
            InvariantResultRow.run_scenario_id,
            InvariantResultRow.invariant_id,
            InvariantResultRow.status,
        ).where(InvariantResultRow.run_id == run_id)
    )
    invariants = fold_invariant_statuses(
        (None if run_scenario_id is None else keys[run_scenario_id], invariant_id, status)
        for run_scenario_id, invariant_id, status in rows
        if run_scenario_id is None or run_scenario_id in keys
    )
    return RunResults(scenarios=scenarios, invariants=invariants)
