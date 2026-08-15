import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, tzinfo
from typing import Any

from pydantic import JsonValue, ValidationError
from sqlalchemy import ScalarResult, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import (
    BundleRow,
    OracleTemplateRow,
    RunRow,
    RunScenarioRow,
    ScenarioRow,
    StepRow,
)
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import OracleResultStatus
from tessa_api.schemas.oracles import DbCheck, GoldPoint
from tessa_api.schemas.runs import ClockSnapshot, RunConfigSnapshot
from tessa_api.schemas.scenario import DbExpect, ExpectDb, GoldFrom, ScenarioDoc, ScenarioStep
from tessa_api.schemas.temporal import (
    CheckDbExpectationInput,
    CheckDbExpectationResult,
    ResolveGoldPointsInput,
    ResolveGoldPointsResult,
)
from tessa_api.services.gold_interpolation import UnknownGoldKeyError, interpolate_gold_value
from tessa_api.services.oracle_params import ParameterSourceError, fill_parameter_sources
from tessa_api.services.scenario_variables import with_run_marker
from tessa_worker.truth.clock import manifest_timezone, utc_now
from tessa_worker.truth.db_expectation import evaluate_db_expectation, expectation_holds
from tessa_worker.truth.oracle_errors import OracleExecutionError
from tessa_worker.truth.oracle_service import OracleOutcome, OracleService
from tessa_worker.truth.sandbox import RenderError
from tessa_worker.truth.truth_verdicts import (
    ORACLE_ERROR,
    OracleStanding,
    db_checks_verdict,
    gate_check,
    gold_unavailable_verdict,
    oracle_gate_verdict,
    oracle_not_found_verdict,
    oracle_truncated_verdict,
    params_invalid_verdict,
)
from tessa_worker.verdicts import uncertain_verdict

SCENARIO_NOT_FOUND = "scenario_not_found"


@dataclass(frozen=True, slots=True)
class StepScope:
    run_id: uuid.UUID
    run_scenario_id: uuid.UUID
    target_id: uuid.UUID
    bundle_id: uuid.UUID
    role: str
    clock: ClockSnapshot
    zone: tzinfo


@dataclass(frozen=True, slots=True)
class GoldResolution:
    gold_points: list[GoldPoint]
    blocked: Verdict | None = None


@dataclass(frozen=True, slots=True)
class DbCheckOutcome:
    db_checks: list[DbCheck]
    verdict: Verdict


def non_retryable(message: str) -> ApplicationError:
    return ApplicationError(message, type=SCENARIO_NOT_FOUND, non_retryable=True)


def interpolated_expectation(expect: DbExpect, gold: Mapping[str, GoldPoint]) -> DbExpect:
    document = expect.model_dump(mode="json", by_alias=True, exclude_none=True)
    return DbExpect.model_validate(interpolate_gold_value(document, gold))


def blocked_check_outcome(
    standing: OracleStanding, verdict: Verdict, oracle_result_id: uuid.UUID | None = None
) -> DbCheckOutcome:
    return DbCheckOutcome([gate_check(standing, verdict, oracle_result_id)], verdict)


class StepChecks:
    def __init__(self, session_factory: SessionFactory, oracles: OracleService) -> None:
        self.session_factory = session_factory
        self.oracles = oracles

    async def load_scope(self, run_id: uuid.UUID, run_scenario_id: uuid.UUID) -> StepScope:
        async with self.session_factory() as session:
            run = await session.get(RunRow, run_id)
            run_scenario = await session.get(RunScenarioRow, run_scenario_id)
            if run is None or run_scenario is None:
                raise non_retryable(f"run {run_id} or run scenario {run_scenario_id} not found")
            if run.target_id is None or run.bundle_id is None:
                raise non_retryable(f"run {run_id} has no target or bundle")
            bundle = await session.get(BundleRow, run.bundle_id)
        clock = RunConfigSnapshot.model_validate(run.config_snapshot).clock
        zone: tzinfo = UTC
        if bundle is not None and bundle.manifest is not None:
            zone = manifest_timezone(BundleManifest.model_validate(bundle.manifest))
        return StepScope(
            run_id=run_id,
            run_scenario_id=run_scenario_id,
            target_id=run.target_id,
            bundle_id=run.bundle_id,
            role=run_scenario.role,
            clock=clock or ClockSnapshot(mode="real", at=utc_now()),
            zone=zone,
        )

    async def template_for(self, scope: StepScope, name: str) -> OracleTemplateRow | None:
        async with self.session_factory() as session:
            return await self.oracles.find_template(session, scope.bundle_id, name)

    def with_sources(
        self, scope: StepScope, template: OracleTemplateRow, given: Mapping[str, JsonValue]
    ) -> dict[str, JsonValue]:
        return fill_parameter_sources(
            template.params_schema, given, scope.clock.at, scope.zone, scope.role
        )

    async def resolve_gold(self, scope: StepScope, gold_from: GoldFrom) -> GoldResolution:
        name = gold_from.oracle
        template = await self.template_for(scope, name)
        if template is None:
            return GoldResolution([], oracle_not_found_verdict(name))
        before = oracle_gate_verdict(OracleStanding(name, template.approval, OracleResultStatus.ok))
        if before is not None:
            return GoldResolution([], before)
        try:
            params = self.with_sources(scope, template, gold_from.params)
        except ParameterSourceError as error:
            return GoldResolution([], params_invalid_verdict(name, str(error)))
        outcome = await self.oracles.run_fresh(template, params, scope.run_id)
        standing = OracleStanding(name, template.approval, outcome.status, outcome.error)
        blocked = oracle_gate_verdict(standing)
        if blocked is None and outcome.rows_truncated:
            blocked = oracle_truncated_verdict(name)
        if blocked is not None:
            return GoldResolution([], blocked)
        return await self.gold_from_outcome(template, params, outcome)

    async def gold_from_outcome(
        self, template: OracleTemplateRow, params: Mapping[str, JsonValue], outcome: OracleOutcome
    ) -> GoldResolution:
        try:
            points = await self.oracles.gold_points_of(template, params, outcome)
        except (OracleExecutionError, RenderError) as error:
            return GoldResolution(
                [],
                uncertain_verdict(
                    ORACLE_ERROR, f"oracle {template.name}: gold points failed: {error.message}"
                ),
            )
        return GoldResolution(points)

    async def check_db(
        self, scope: StepScope, expect_db: ExpectDb, gold: Mapping[str, GoldPoint]
    ) -> DbCheckOutcome:
        name = expect_db.oracle
        template = await self.template_for(scope, name)
        if template is None:
            return blocked_check_outcome(
                OracleStanding(name, None, None), oracle_not_found_verdict(name)
            )
        pending = OracleStanding(name, template.approval, OracleResultStatus.ok)
        before = oracle_gate_verdict(pending)
        if before is not None:
            return blocked_check_outcome(pending, before)
        try:
            expect = interpolated_expectation(expect_db.expect, gold)
        except (UnknownGoldKeyError, ValidationError) as error:
            return blocked_check_outcome(pending, gold_unavailable_verdict(str(error)[:300]))
        try:
            params = self.with_sources(scope, template, expect_db.params)
        except ParameterSourceError as error:
            return blocked_check_outcome(pending, params_invalid_verdict(name, str(error)))
        outcome = await self.oracles.run_polling(
            template,
            params,
            scope.run_id,
            lambda execution: expectation_holds(expect, execution.rows, execution.rows_truncated),
            float(expect_db.retry_for_seconds),
        )
        standing = OracleStanding(name, template.approval, outcome.status, outcome.error)
        gate = oracle_gate_verdict(standing)
        if gate is not None:
            return blocked_check_outcome(standing, gate, outcome.result_id)
        checks = evaluate_db_expectation(
            expect, outcome.rows, outcome.rows_truncated, outcome.result_id
        )
        return DbCheckOutcome(checks, db_checks_verdict(standing, checks))

    async def scenario_step(
        self, session: AsyncSession, run_scenario_id: uuid.UUID, index: int
    ) -> tuple[RunScenarioRow, ScenarioStep]:
        run_scenario = await session.get(RunScenarioRow, run_scenario_id)
        scenario = (
            await session.get(ScenarioRow, run_scenario.scenario_id) if run_scenario else None
        )
        if run_scenario is None or scenario is None:
            raise non_retryable(f"run scenario {run_scenario_id} or its scenario was not found")
        document = ScenarioDoc.model_validate(scenario.parsed)
        if index >= len(document.steps):
            raise non_retryable(f"scenario of run scenario {run_scenario_id} has no step {index}")
        return run_scenario, with_run_marker(document.steps[index], run_scenario.run_id)

    async def resolve_gold_for_step(
        self, request: ResolveGoldPointsInput
    ) -> ResolveGoldPointsResult:
        async with self.session_factory() as session:
            run_scenario, step = await self.scenario_step(
                session, request.run_scenario_id, request.step_index
            )
        if step.gold_from is None:
            return ResolveGoldPointsResult(gold_points=[])
        scope = await self.load_scope(run_scenario.run_id, request.run_scenario_id)
        resolution = await self.resolve_gold(scope, step.gold_from)
        return ResolveGoldPointsResult(
            gold_points=resolution.gold_points, blocked=resolution.blocked
        )

    async def earlier_gold(self, session: AsyncSession, step: StepRow) -> dict[str, GoldPoint]:
        stored: ScalarResult[list[dict[str, Any]]] = await session.scalars(
            select(StepRow.gold_points)
            .where(
                StepRow.run_scenario_id == step.run_scenario_id,
                StepRow.attempt == step.attempt,
                StepRow.index <= step.index,
            )
            .order_by(StepRow.index)
        )
        merged: dict[str, GoldPoint] = {}
        for points in stored:
            for point in points:
                parsed = GoldPoint.model_validate(point)
                merged[parsed.key] = parsed
        return merged

    async def check_db_for_step(self, request: CheckDbExpectationInput) -> CheckDbExpectationResult:
        async with self.session_factory() as session:
            step_row = await session.get(StepRow, request.step_id)
            if step_row is None:
                raise non_retryable(f"step {request.step_id} not found")
            run_scenario, step = await self.scenario_step(
                session, step_row.run_scenario_id, step_row.index
            )
            gold = await self.earlier_gold(session, step_row)
        if step.expect_db is None:
            return CheckDbExpectationResult(db_checks=[])
        scope = await self.load_scope(run_scenario.run_id, step_row.run_scenario_id)
        outcome = await self.check_db(scope, step.expect_db, gold)
        await self.store_db_checks(request.step_id, outcome.db_checks)
        return CheckDbExpectationResult(db_checks=outcome.db_checks, verdict=outcome.verdict)

    async def store_db_checks(self, step_id: uuid.UUID, checks: list[DbCheck]) -> None:
        async with self.session_factory() as session:
            await session.execute(
                update(StepRow)
                .where(StepRow.id == step_id)
                .values(db_checks=[check.model_dump(mode="json") for check in checks])
            )
            await session.commit()
