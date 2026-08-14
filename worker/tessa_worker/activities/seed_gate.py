from uuid import UUID

from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, RunRow, SeedRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import SeedAction
from tessa_api.schemas.temporal import SeedAssertionResult, SeedTargetResult
from tessa_api.services.seed_resolution import seed_in_force
from tessa_worker.activities.config_snapshot import (
    RUN_NOT_FOUND,
    lock_unfrozen_run,
    merge_into_config,
)
from tessa_worker.activities.names import ASSERT_SEED, PLAN_SEED_ASSERTION
from tessa_worker.activities.run_models import (
    SEED_UNVERIFIED_REASON,
    AssertSeedInput,
    SeedAssertionPlan,
    SettleSeedAssertionInput,
)
from tessa_worker.truth.errors import SeedFailureCode
from tessa_worker.verdicts import clip_reason

UNKNOWN_FAILURE_CODE = "seed_failed"
UNKNOWN_FAILURE_MESSAGE = "the seed check failed without a message"
UNVERIFIABLE_CODES = frozenset(
    {
        SeedFailureCode.hook_missing.value,
        SeedFailureCode.baseline_missing.value,
        SeedFailureCode.env_missing.value,
        SeedFailureCode.material_missing.value,
        SeedFailureCode.script_unsupported.value,
    }
)


def unverified_reason(detail: str) -> str:
    return f"{SEED_UNVERIFIED_REASON}: {detail}"


def unverified_plan(detail: str | None) -> SeedAssertionPlan:
    reason = SEED_UNVERIFIED_REASON if detail is None else unverified_reason(detail)
    return SeedAssertionPlan(unverified_reason=reason)


def plan_assertion(
    read_only: bool, target_id: UUID, seed: SeedRow | None, reset_seed: bool
) -> SeedAssertionPlan:
    if read_only:
        if reset_seed:
            return SeedAssertionPlan(
                failure_reason="reset_seed is refused on a production run: seeds are never reset"
            )
        return unverified_plan("production runs never execute seed scripts")
    if seed is None:
        return unverified_plan(None)
    if reset_seed:
        if seed.reset_script_path is None:
            return SeedAssertionPlan(
                failure_reason=f"{SeedFailureCode.hook_missing.value}: the seed has no reset script"
            )
        return SeedAssertionPlan(target_id=target_id, seed_id=seed.id, action=SeedAction.reset)
    if seed.hash_command is None:
        return unverified_plan("the seed has no hash command")
    if seed.declared_hash is None:
        return unverified_plan(
            "the seed has no expected hash yet; reset it once so the first hash is recorded"
        )
    return SeedAssertionPlan(target_id=target_id, seed_id=seed.id, action=SeedAction.verify)


def result_assertion(result: SeedTargetResult) -> SeedAssertionResult:
    if not result.matched:
        reason = (
            "seed mismatch: the target data differs from the seed "
            f"(observed {result.observed_hash}, expected {result.expected_hash})"
        )
        return SeedAssertionResult(
            outcome="mismatch",
            seed_hash=None,
            observed_hash=result.observed_hash,
            expected_hash=result.expected_hash,
            reason=clip_reason(reason),
        )
    if result.observed_hash is None:
        return SeedAssertionResult(
            outcome="unverified",
            seed_hash=None,
            observed_hash=None,
            expected_hash=result.expected_hash,
            reason=unverified_reason(
                "the reset finished but the seed has no hash command, so the state was not verified"
            ),
        )
    return SeedAssertionResult(
        outcome="matched",
        seed_hash=result.observed_hash,
        observed_hash=result.observed_hash,
        expected_hash=result.expected_hash,
        reason=None,
    )


def failure_assertion(request: SettleSeedAssertionInput) -> SeedAssertionResult:
    code = request.failure_code or UNKNOWN_FAILURE_CODE
    message = request.failure_message or UNKNOWN_FAILURE_MESSAGE
    if request.action is SeedAction.verify and code in UNVERIFIABLE_CODES:
        return SeedAssertionResult(
            outcome="unverified",
            seed_hash=None,
            observed_hash=None,
            expected_hash=None,
            reason=clip_reason(unverified_reason(f"{code}: {message}")),
        )
    return SeedAssertionResult(
        outcome="failed",
        seed_hash=None,
        observed_hash=None,
        expected_hash=None,
        reason=clip_reason(f"seed {request.action.value} failed: {code}: {message}"),
    )


def settle_assertion(request: SettleSeedAssertionInput) -> SeedAssertionResult:
    if request.result is None:
        return failure_assertion(request)
    return result_assertion(request.result)


class SeedGateActivities:
    def __init__(self, session_factory: SessionFactory) -> None:
        self.session_factory = session_factory

    @activity.defn(name=PLAN_SEED_ASSERTION)
    async def plan_seed_assertion(self, request: AssertSeedInput) -> SeedAssertionPlan:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            if run is None or run.target_id is None or run.bundle_id is None:
                raise ApplicationError(
                    f"run {request.run_id} does not exist or has no target and bundle",
                    type=RUN_NOT_FOUND,
                    non_retryable=True,
                )
            bundle = await session.get(BundleRow, run.bundle_id)
            seed = None if bundle is None else await seed_in_force(session, bundle)
            return plan_assertion(run.read_only, run.target_id, seed, request.reset_seed)

    @activity.defn(name=ASSERT_SEED)
    async def assert_seed(self, request: SettleSeedAssertionInput) -> SeedAssertionResult:
        assertion = settle_assertion(request)
        if assertion.outcome == "matched" and assertion.seed_hash is not None:
            await self.pin_seed_hash(request.run_id, assertion.seed_hash)
        return assertion

    async def pin_seed_hash(self, run_id: UUID, seed_hash: str) -> None:
        async with self.session_factory() as session:
            run = await lock_unfrozen_run(session, run_id)
            merge_into_config(run, {"seed_hash": seed_hash})
            await session.commit()
