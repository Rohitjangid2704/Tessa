from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.temporal import (
    CHECK_DB_EXPECTATION_ACTIVITY,
    EXECUTE_ORACLE_QUERY_ACTIVITY,
    RENDER_EXPECTED_SENTENCE_ACTIVITY,
    RESOLVE_GOLD_POINTS_ACTIVITY,
    CheckDbExpectationInput,
    CheckDbExpectationResult,
    ExecuteOracleQueryInput,
    ExecuteOracleQueryResult,
    RenderExpectedSentenceInput,
    RenderExpectedSentenceResult,
    ResolveGoldPointsInput,
    ResolveGoldPointsResult,
)
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.oracle_models import FAIL_ORACLE_RESULT, FailOracleResultInput
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.oracle_errors import OracleExecutionError
from tessa_worker.truth.oracle_service import OracleService
from tessa_worker.truth.step_checks import StepChecks

ORACLE_RESULT_NOT_FOUND = "oracle_result_not_found"


def unknown_result(error: OracleExecutionError) -> ApplicationError:
    return ApplicationError(error.message, type=ORACLE_RESULT_NOT_FOUND, non_retryable=True)


class OracleActivities:
    def __init__(self, oracles: OracleService, checks: StepChecks) -> None:
        self.oracles = oracles
        self.checks = checks

    @activity.defn(name=EXECUTE_ORACLE_QUERY_ACTIVITY)
    async def execute_oracle_query(
        self, request: ExecuteOracleQueryInput
    ) -> ExecuteOracleQueryResult:
        try:
            return await self.oracles.execute(request.oracle_result_id)
        except OracleExecutionError as error:
            raise unknown_result(error) from None

    @activity.defn(name=RENDER_EXPECTED_SENTENCE_ACTIVITY)
    async def render_expected_sentence(
        self, request: RenderExpectedSentenceInput
    ) -> RenderExpectedSentenceResult:
        try:
            return await self.oracles.render(request.oracle_result_id)
        except OracleExecutionError as error:
            raise unknown_result(error) from None

    @activity.defn(name=FAIL_ORACLE_RESULT)
    async def fail_oracle_result(self, request: FailOracleResultInput) -> None:
        await self.oracles.fail(request.oracle_result_id, request.message)

    @activity.defn(name=RESOLVE_GOLD_POINTS_ACTIVITY)
    async def resolve_gold_points(self, request: ResolveGoldPointsInput) -> ResolveGoldPointsResult:
        return await self.checks.resolve_gold_for_step(request)

    @activity.defn(name=CHECK_DB_EXPECTATION_ACTIVITY)
    async def check_db_expectation(
        self, request: CheckDbExpectationInput
    ) -> CheckDbExpectationResult:
        return await self.checks.check_db_for_step(request)


def default_oracle_activities(
    settings: WorkerSettings, session_factory: SessionFactory
) -> OracleActivities:
    oracles = OracleService(session_factory, vault_from_settings(settings), settings)
    return OracleActivities(oracles, StepChecks(session_factory, oracles))
