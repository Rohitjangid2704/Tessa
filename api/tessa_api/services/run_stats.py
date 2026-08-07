import math
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import (
    FindingRow,
    InvariantResultRow,
    ModelCallRow,
    PlanRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
)
from tessa_api.errors import not_found
from tessa_api.schemas.common import Probability, Verdict
from tessa_api.schemas.enums import (
    FindingStatus,
    InvariantPack,
    RunScenarioStatus,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.run_stats import (
    CostPercentiles,
    FamilyStats,
    InvariantStats,
    LatencyPercentiles,
    RunStats,
    TierMix,
)
from tessa_api.services.run_counters import DONE_SCENARIO_STATUSES
from tessa_api.services.verdicts import (
    across_attempts_status,
    passes_all_attempts,
    within_attempt_status,
)

OPEN_FINDING_STATUSES = frozenset(
    {FindingStatus.new, FindingStatus.triaged, FindingStatus.in_fix, FindingStatus.verifying}
)
EXECUTED_STATUSES = frozenset({RunScenarioStatus.finished, RunScenarioStatus.errored})
PACK_ORDER = {InvariantPack.generic: 0, InvariantPack.llm_app: 1, InvariantPack.target: 2}
PERCENT_P50 = 50
PERCENT_P90 = 90
PERCENT_P99 = 99
USD_DECIMALS = 6
DEFAULT_ATTEMPTS = 1

AttemptKey = tuple[str, InvariantPack, UUID | None, int | None]
ScenarioKey = tuple[str, InvariantPack, UUID | None]
InvariantKey = tuple[str, InvariantPack]


@dataclass(frozen=True, slots=True)
class ScenarioFact:
    run_scenario_id: UUID
    family: str
    status: RunScenarioStatus
    verdict: Verdict | None
    attempt_verdicts: tuple[Verdict | None, ...]
    attempts_total: int

    @property
    def verdict_status(self) -> VerdictStatus | None:
        return None if self.verdict is None else self.verdict.status

    @property
    def executed(self) -> bool:
        return (
            self.status in EXECUTED_STATUSES
            and self.verdict is not None
            and self.verdict.status is not VerdictStatus.skipped
        )

    @property
    def passed_all_attempts(self) -> bool:
        return passes_all_attempts(self.attempt_verdicts, self.attempts_total)


@dataclass(frozen=True, slots=True)
class InvariantFact:
    run_scenario_id: UUID | None
    attempt: int | None
    invariant_id: str
    pack: InvariantPack
    status: VerdictStatus


def ratio(part: int, whole: int) -> Probability | None:
    return None if whole == 0 else part / whole


def nearest_rank(values: Iterable[float], percent: int) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    rank = max(1, math.ceil(percent / 100 * len(ordered)))
    return ordered[min(len(ordered), rank) - 1]


def verdict_of(raw: dict[str, Any] | None) -> Verdict | None:
    return None if raw is None else Verdict.model_validate(raw)


def attempt_verdicts_of(attempts: Sequence[dict[str, Any]]) -> tuple[Verdict | None, ...]:
    ordered = sorted(attempts, key=lambda entry: entry["attempt"])
    return tuple(verdict_of(entry.get("verdict")) for entry in ordered)


def count_passing_all(facts: Sequence[ScenarioFact]) -> int:
    return sum(fact.passed_all_attempts for fact in facts)


def count_with_status(facts: Sequence[ScenarioFact], status: VerdictStatus) -> int:
    return sum(fact.verdict_status is status for fact in facts)


def family_stats(facts: Sequence[ScenarioFact]) -> list[FamilyStats]:
    by_family: dict[str, list[ScenarioFact]] = defaultdict(list)
    for fact in facts:
        if fact.status in DONE_SCENARIO_STATUSES:
            by_family[fact.family].append(fact)
    stats: list[FamilyStats] = []
    for family in sorted(by_family):
        members = by_family[family]
        executed = [fact for fact in members if fact.executed]
        stats.append(
            FamilyStats(
                family=family,
                scenarios=len(members),
                pass_hat_k=ratio(count_passing_all(executed), len(executed)),
                flaky=count_with_status(members, VerdictStatus.flaky),
                uncertain=count_with_status(members, VerdictStatus.uncertain),
                skipped=count_with_status(members, VerdictStatus.skipped),
            )
        )
    return stats


def invariant_stats(facts: Sequence[InvariantFact]) -> list[InvariantStats]:
    per_attempt: dict[AttemptKey, list[VerdictStatus]] = defaultdict(list)
    for fact in facts:
        key = (fact.invariant_id, fact.pack, fact.run_scenario_id, fact.attempt)
        per_attempt[key].append(fact.status)
    per_scenario: dict[ScenarioKey, list[VerdictStatus]] = defaultdict(list)
    for (invariant_id, pack, run_scenario_id, _attempt), statuses in per_attempt.items():
        per_scenario[(invariant_id, pack, run_scenario_id)].append(within_attempt_status(statuses))
    tallies: dict[InvariantKey, Counter[VerdictStatus]] = defaultdict(Counter)
    for (invariant_id, pack, _run_scenario_id), statuses in per_scenario.items():
        tallies[(invariant_id, pack)][across_attempts_status(statuses)] += 1
    ordered = sorted(tallies, key=lambda key: (PACK_ORDER[key[1]], key[0]))
    return [
        InvariantStats(
            invariant_id=invariant_id,
            pack=pack,
            pass_=tallies[(invariant_id, pack)][VerdictStatus.pass_],
            fail=tallies[(invariant_id, pack)][VerdictStatus.fail],
            flaky=tallies[(invariant_id, pack)][VerdictStatus.flaky],
            uncertain=tallies[(invariant_id, pack)][VerdictStatus.uncertain],
            skipped=tallies[(invariant_id, pack)][VerdictStatus.skipped],
        )
        for invariant_id, pack in ordered
    ]


def latency_percentiles(latencies: Sequence[int]) -> LatencyPercentiles:
    return LatencyPercentiles(
        p50=int(nearest_rank(latencies, PERCENT_P50)),
        p90=int(nearest_rank(latencies, PERCENT_P90)),
        p99=int(nearest_rank(latencies, PERCENT_P99)),
    )


def cost_percentiles(total_usd: float, scenario_costs: Sequence[float]) -> CostPercentiles:
    return CostPercentiles(
        total=round(total_usd, USD_DECIMALS),
        p50=round(nearest_rank(scenario_costs, PERCENT_P50), USD_DECIMALS),
        p90=round(nearest_rank(scenario_costs, PERCENT_P90), USD_DECIMALS),
    )


def attempts_per_scenario(facts: Sequence[ScenarioFact], planned: int | None) -> int:
    declared = max((fact.attempts_total for fact in facts), default=planned or DEFAULT_ATTEMPTS)
    return max(DEFAULT_ATTEMPTS, declared)


async def load_scenario_facts(session: AsyncSession, run_id: UUID) -> list[ScenarioFact]:
    rows = await session.execute(
        select(
            RunScenarioRow.id,
            ScenarioRow.family,
            RunScenarioRow.status,
            RunScenarioRow.verdict,
            RunScenarioRow.attempts,
            RunScenarioRow.attempts_total,
        )
        .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
        .where(RunScenarioRow.run_id == run_id)
        .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
    )
    return [
        ScenarioFact(
            run_scenario_id=run_scenario_id,
            family=family,
            status=status,
            verdict=verdict_of(verdict),
            attempt_verdicts=attempt_verdicts_of(attempts),
            attempts_total=attempts_total,
        )
        for run_scenario_id, family, status, verdict, attempts, attempts_total in rows
    ]


async def load_invariant_facts(session: AsyncSession, run_id: UUID) -> list[InvariantFact]:
    rows = await session.execute(
        select(
            InvariantResultRow.run_scenario_id,
            InvariantResultRow.attempt,
            InvariantResultRow.invariant_id,
            InvariantResultRow.pack,
            InvariantResultRow.status,
        ).where(InvariantResultRow.run_id == run_id)
    )
    return [InvariantFact(*row) for row in rows]


async def load_step_latencies(session: AsyncSession, run_id: UUID) -> list[int]:
    rows = await session.scalars(select(StepRow.latency_ms).where(StepRow.run_id == run_id))
    return list(rows)


async def load_tier_mix(session: AsyncSession, run_id: UUID) -> TierMix:
    tier = StepRow.verdict["tier"].as_string()
    rows = await session.execute(
        select(tier, func.count())
        .where(StepRow.run_id == run_id, StepRow.verdict.is_not(None))
        .group_by(tier)
    )
    counts = {VerdictTier(name): count for name, count in rows if name is not None}
    return TierMix(
        code=counts.get(VerdictTier.code, 0),
        laya=counts.get(VerdictTier.laya, 0),
        judge=counts.get(VerdictTier.judge, 0),
        human=counts.get(VerdictTier.human, 0),
    )


async def load_scenario_model_costs(session: AsyncSession, run_id: UUID) -> dict[UUID, float]:
    rows = await session.execute(
        select(StepRow.run_scenario_id, func.sum(ModelCallRow.cost_usd))
        .select_from(ModelCallRow)
        .join(StepRow, StepRow.id == ModelCallRow.step_id)
        .where(ModelCallRow.run_id == run_id)
        .group_by(StepRow.run_scenario_id)
    )
    return {run_scenario_id: float(total) for run_scenario_id, total in rows}


async def count_open_findings(session: AsyncSession, target_id: UUID | None) -> int:
    if target_id is None:
        return 0
    counted = await session.scalar(
        select(func.count())
        .select_from(FindingRow)
        .where(
            FindingRow.target_id == target_id, FindingRow.status.in_(list(OPEN_FINDING_STATUSES))
        )
    )
    return counted or 0


async def planned_attempts(session: AsyncSession, run: RunRow) -> int | None:
    if run.plan_id is None:
        return None
    return await session.scalar(select(PlanRow.k).where(PlanRow.id == run.plan_id))


async def get_run(session: AsyncSession, run_id: UUID) -> RunRow:
    run = await session.get(RunRow, run_id)
    if run is None:
        raise not_found("Run not found")
    return run


async def build_run_stats(session: AsyncSession, run_id: UUID) -> RunStats:
    run = await get_run(session, run_id)
    scenarios = await load_scenario_facts(session, run_id)
    executed = [fact for fact in scenarios if fact.executed]
    model_costs = await load_scenario_model_costs(session, run_id)
    return RunStats(
        k=attempts_per_scenario(scenarios, await planned_attempts(session, run)),
        pass_hat_k=ratio(count_passing_all(executed), len(executed)),
        flaky_rate=ratio(count_with_status(executed, VerdictStatus.flaky), len(executed)),
        open_findings=await count_open_findings(session, run.target_id),
        families=family_stats(scenarios),
        invariants=invariant_stats(await load_invariant_facts(session, run_id)),
        latency_ms=latency_percentiles(await load_step_latencies(session, run_id)),
        cost_usd=cost_percentiles(
            float(run.spent_usd),
            [model_costs.get(fact.run_scenario_id, 0.0) for fact in executed],
        ),
        tiers=await load_tier_mix(session, run_id),
    )


async def read_run_stats(session: AsyncSession, run_id: UUID) -> RunStats:
    run = await get_run(session, run_id)
    if run.stats is not None:
        return RunStats.model_validate(run.stats)
    return await build_run_stats(session, run_id)


async def freeze_run_stats(session: AsyncSession, run_id: UUID) -> RunStats:
    stats = await build_run_stats(session, run_id)
    run = await get_run(session, run_id)
    run.stats = stats.model_dump(mode="json", by_alias=True)
    return stats
