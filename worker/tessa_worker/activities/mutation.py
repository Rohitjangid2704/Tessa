import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal

import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, MutantRow, MutationRunRow, RunRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import MutantStatus, RunKind
from tessa_api.schemas.mutants import DeployedMarker
from tessa_api.schemas.streams import MutationOutcomePayload
from tessa_api.schemas.temporal import (
    SCORE_MUTATION_ACTIVITY,
    ScoreMutationInput,
    ScoreMutationResult,
)
from tessa_api.services.mutation_scoring import RunResults, score_mutation_run
from tessa_api.services.run_service import run_created_event
from tessa_api.services.settings_service import effective_settings
from tessa_api.services.vault import Vault
from tessa_worker.activities.mutation_models import (
    BASELINE_UNUSABLE,
    CLOSE_MUTATION_RUN,
    MARKER_REASON_MAX_CHARS,
    MARKER_UNREACHABLE,
    MUTANT_NOT_DEPLOYED,
    MUTATION_RUN_NOT_FOUND,
    OVERRIDE_NOT_APPLICABLE,
    PREPARE_MUTATION_RUN,
    RESOLVE_BASELINE_RUN,
    VERIFY_DEPLOYED_MARKER,
    CloseMutationRunInput,
    MutationRunContext,
    PrepareMutationRunInput,
    ResolveBaselineInput,
    ResolvedBaseline,
    VerifiedMarker,
    VerifyDeployedMarkerInput,
)
from tessa_worker.adapters.auth import load_environment
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.mutation.baseline import (
    baseline_is_finished,
    find_reusable_baseline,
    new_baseline_run,
)
from tessa_worker.mutation.marker import MarkerUnreachableError, check_deployed_marker
from tessa_worker.mutation.override import (
    OverrideNotApplicableError,
    apply_base_url_override,
    read_base_url_override,
)
from tessa_worker.mutation.results import EMPTY_RESULTS, load_run_results
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.mutation")


def permanent(message: str, error_type: str) -> ApplicationError:
    return ApplicationError(message, type=error_type, non_retryable=True)


class MutationRecords:
    def __init__(self, mutation: MutationRunRow, run: RunRow, mutant: MutantRow) -> None:
        self.mutation = mutation
        self.run = run
        self.mutant = mutant


async def load_records(
    session: AsyncSession, mutation_run_id: uuid.UUID, lock: bool = False
) -> MutationRecords:
    mutation = await session.get(MutationRunRow, mutation_run_id, with_for_update=lock)
    run = None if mutation is None else await session.get(RunRow, mutation.run_id)
    mutant = None if mutation is None else await session.get(MutantRow, mutation.mutant_id)
    if mutation is None or run is None or mutant is None:
        raise permanent(f"mutation run {mutation_run_id} does not exist", MUTATION_RUN_NOT_FOUND)
    if run.kind is not RunKind.mutation:
        raise permanent(f"run {run.id} is not a mutation run", MUTATION_RUN_NOT_FOUND)
    return MutationRecords(mutation, run, mutant)


def clipped_reason(text: str | None) -> str | None:
    if text is None or len(text) <= MARKER_REASON_MAX_CHARS:
        return text
    return f"{text[: MARKER_REASON_MAX_CHARS - 3]}..."


class MutationActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        vault: Vault,
        events: EventClient,
        client_factory: Callable[[], httpx.AsyncClient] = httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.vault = vault
        self.events = events
        self.client_factory = client_factory

    @activity.defn(name=PREPARE_MUTATION_RUN)
    async def prepare_mutation_run(self, request: PrepareMutationRunInput) -> MutationRunContext:
        async with self.session_factory() as session:
            records = await load_records(session, request.mutation_run_id)
            run, mutant = records.run, records.mutant
            if run.id != request.run_id or run.target_id is None or run.bundle_id is None:
                raise permanent(
                    f"run {request.run_id} is not the run of mutation run "
                    f"{request.mutation_run_id}",
                    MUTATION_RUN_NOT_FOUND,
                )
            if mutant.status is not MutantStatus.deployed:
                raise permanent(
                    f"the mutant {mutant.name!r} is {mutant.status.value}, not deployed",
                    MUTANT_NOT_DEPLOYED,
                )
            await self.ensure_override_applies(session, run)
            effective = await effective_settings(session, self.settings)
            return MutationRunContext(
                target_id=run.target_id,
                mutant_name=mutant.name,
                marker_declared=mutant.deployed_marker is not None,
                max_concurrency=effective.run_max_concurrency,
            )

    async def ensure_override_applies(self, session: AsyncSession, run: RunRow) -> None:
        override = await read_base_url_override(session, run.id)
        bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
        if override is None or run.target_id is None or bundle is None or bundle.manifest is None:
            raise permanent(
                f"run {run.id} has no address of the mutant or no readable bundle",
                OVERRIDE_NOT_APPLICABLE,
            )
        manifest = BundleManifest.model_validate(bundle.manifest)
        environment = await load_environment(session, self.vault, run.target_id)
        try:
            apply_base_url_override(manifest, environment, override)
        except OverrideNotApplicableError as error:
            raise permanent(str(error), OVERRIDE_NOT_APPLICABLE) from None

    @activity.defn(name=VERIFY_DEPLOYED_MARKER)
    async def verify_deployed_marker(self, request: VerifyDeployedMarkerInput) -> VerifiedMarker:
        async with self.session_factory() as session:
            records = await load_records(session, request.mutation_run_id)
            override = await read_base_url_override(session, records.run.id)
            marker_document = records.mutant.deployed_marker
            address = override or records.mutant.base_url
        if marker_document is None:
            return VerifiedMarker(checked=False, ok=True, reason=None)
        if address is None:
            return VerifiedMarker(
                checked=True, ok=False, reason="the mutant has no address to read the marker from"
            )
        try:
            check = await check_deployed_marker(
                address, DeployedMarker.model_validate(marker_document), self.client_factory
            )
        except MarkerUnreachableError as error:
            raise ApplicationError(str(error), type=MARKER_UNREACHABLE) from None
        return VerifiedMarker(checked=True, ok=check.ok, reason=clipped_reason(check.reason))

    async def known_baseline(
        self, session: AsyncSession, records: MutationRecords, now: datetime
    ) -> ResolvedBaseline | None:
        mutation = records.mutation
        if mutation.baseline_run_id is not None:
            return ResolvedBaseline(
                baseline_run_id=mutation.baseline_run_id,
                reused=await baseline_is_finished(session, mutation.baseline_run_id),
            )
        reusable = await find_reusable_baseline(
            session, records.run, now, self.settings.mutation_baseline_max_age_hours
        )
        if reusable is None:
            return None
        mutation.baseline_run_id = reusable.id
        return ResolvedBaseline(baseline_run_id=reusable.id, reused=True)

    async def create_baseline(
        self, session: AsyncSession, records: MutationRecords, now: datetime
    ) -> RunRow:
        run = records.run
        bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
        if bundle is None:
            raise permanent(
                f"run {run.id} has no bundle, so no baseline can be created", BASELINE_UNUSABLE
            )
        baseline = new_baseline_run(run, bundle, now)
        session.add(baseline)
        await session.flush()
        records.mutation.baseline_run_id = baseline.id
        return baseline

    @activity.defn(name=RESOLVE_BASELINE_RUN)
    async def resolve_baseline_run(self, request: ResolveBaselineInput) -> ResolvedBaseline:
        now = datetime.now(UTC)
        async with self.session_factory() as session:
            records = await load_records(session, request.mutation_run_id, lock=True)
            known = await self.known_baseline(session, records, now)
            if known is not None:
                await session.commit()
                return known
            baseline = await self.create_baseline(session, records, now)
            await session.commit()
            created = run_created_event(baseline)
            baseline_run_id = baseline.id
        await self.events.deliver([created])
        logger.info(
            "mutation_baseline_created",
            extra={"run_id": str(request.run_id), "baseline_run_id": str(baseline_run_id)},
        )
        return ResolvedBaseline(baseline_run_id=baseline_run_id, reused=False)

    @activity.defn(name=SCORE_MUTATION_ACTIVITY)
    async def score_mutation(self, request: ScoreMutationInput) -> ScoreMutationResult:
        async with self.session_factory() as session:
            records = await load_records(session, request.mutation_run_id, lock=True)
            mutation, mutant = records.mutation, records.mutant
            aborted = request.aborted_reason is not None or mutation.baseline_run_id is None
            mutant_results = await self.mutant_results(session, mutation, aborted)
            baseline_results = await self.baseline_results(session, mutation, aborted)
            score = score_mutation_run(
                mutant.expected_catchers, mutant_results, baseline_results, aborted
            )
            mutation.outcomes = [item.model_dump(mode="json") for item in score.outcomes]
            mutation.power = None if score.power is None else Decimal(str(score.power))
            mutant.last_outcome = score.mutant_outcome
            run_id = mutation.run_id
            await session.commit()
        await self.events.deliver(
            [
                build_event(
                    run_id,
                    "mutation.outcome",
                    MutationOutcomePayload(
                        mutation_run_id=request.mutation_run_id,
                        invariant_id=item.invariant_id,
                        outcome=item.outcome,
                        caught_by=item.caught_by,
                    ),
                    f"mutation.outcome:{item.invariant_id}",
                )
                for item in score.outcomes
            ]
        )
        logger.info(
            "mutation_scored",
            extra={
                "run_id": str(run_id),
                "mutant_outcome": score.mutant_outcome.value,
                "new_failures": score.new_failures,
                "aborted": aborted,
            },
        )
        return ScoreMutationResult(
            outcomes=score.outcomes, power=score.power, mutant_outcome=score.mutant_outcome
        )

    async def mutant_results(
        self, session: AsyncSession, mutation: MutationRunRow, aborted: bool
    ) -> RunResults:
        if aborted:
            return EMPTY_RESULTS
        return await load_run_results(session, mutation.run_id)

    async def baseline_results(
        self, session: AsyncSession, mutation: MutationRunRow, aborted: bool
    ) -> RunResults:
        if aborted or mutation.baseline_run_id is None:
            return EMPTY_RESULTS
        return await load_run_results(session, mutation.baseline_run_id)

    @activity.defn(name=CLOSE_MUTATION_RUN)
    async def close_mutation_run(self, request: CloseMutationRunInput) -> None:
        async with self.session_factory() as session:
            records = await load_records(session, request.mutation_run_id, lock=True)
            records.mutation.finished_at = records.run.finished_at or datetime.now(UTC)
            await session.commit()
