import asyncio
import contextlib
import logging
import threading
import uuid
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, PlanRow, RunRow, RunScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import RunScenarioStatus, SkipReason
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.streams import IngestEvent
from tessa_api.schemas.temporal import (
    PREPARE_FUZZ_FAMILY_ACTIVITY,
    RUN_SCHEMATHESIS_ACTIVITY,
    FuzzRoleTarget,
    PrepareFuzzFamilyInput,
    PrepareFuzzFamilyResult,
    RunSchemathesisInput,
    RunSchemathesisResult,
)
from tessa_api.services.scenario_library import scenario_view_for_bundle
from tessa_api.services.storage import BundleStore
from tessa_api.services.vault import Vault
from tessa_worker.activities.drive import heartbeating
from tessa_worker.activities.mutation_models import OVERRIDE_NOT_APPLICABLE
from tessa_worker.adapters.auth import ResolvedEnvironment, load_environment
from tessa_worker.adapters.context import (
    AdapterContext,
    AdapterLimits,
    build_adapter_context,
)
from tessa_worker.adapters.errors import (
    AdapterError,
    InterfaceUnresolvedError,
    MissingPlaceholderError,
)
from tessa_worker.adapters.http import HttpAdapter
from tessa_worker.event_client import EventClient
from tessa_worker.fuzz.checks import MESSAGE_LIMIT, derive_seed, fuzz_failure_of
from tessa_worker.fuzz.engine import FuzzProgress, FuzzSetupError, run_fuzz
from tessa_worker.fuzz.models import FuzzOutcome, FuzzRunConfig, FuzzStop
from tessa_worker.fuzz.persist import StepContext, store_steps
from tessa_worker.fuzz.planning import first_http_interface, fuzz_roles
from tessa_worker.fuzz.redaction import safe_message
from tessa_worker.fuzz.scenarios import (
    ensure_fuzz_scenario,
    ensure_run_scenario,
    lock_fuzz_scenarios,
)
from tessa_worker.fuzz.spec import (
    OpenApiUnavailableError,
    bundle_openapi_ref,
    declares_base_path,
    read_openapi_document,
)
from tessa_worker.mutation.override import (
    OverrideNotApplicableError,
    override_environment,
    read_base_url_override,
)
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.fuzz")

FUZZ_HEARTBEAT_SECONDS = 2.0
FUZZ_REQUEST_TIMEOUT_SECONDS = 30.0
ENGINE_TIME_MARGIN_SECONDS = 30
MIN_ENGINE_SECONDS = 10
MAX_FUZZ_FAILURES = 200
MAX_REPORTED_FAILURES = 100
CANCEL_GRACE_SECONDS = 30.0
DETAIL_LIMIT = 800
MANIFEST_INVALID = "bundle_manifest_invalid"
RUN_NOT_FOUND = "run_not_found"
NOT_IN_RUN = "run_scenario_not_in_run"
STOP_EXPLANATIONS = {
    FuzzStop.time_limit: "the fuzz time limit was reached before every case ran",
    FuzzStop.failure_limit: "the failure limit was reached before every case ran",
    FuzzStop.server_unavailable: "the server stopped accepting connections",
    FuzzStop.engine_failed: "the fuzz engine failed",
    FuzzStop.interrupted: "the fuzz run was interrupted",
}
NO_HTTP_INTERFACE = "api fuzz skipped: the bundle declares no http interface"
NO_ROLES = "api fuzz skipped: the plan selects no role"
PRECONDITION_SKIP = SkipReason.precondition_failed


def permanent(message: str, error_type: str) -> ApplicationError:
    return ApplicationError(message, type=error_type, non_retryable=True)


@dataclass(frozen=True, slots=True)
class Prepared:
    result: PrepareFuzzFamilyResult
    events: list[IngestEvent]


@dataclass(frozen=True, slots=True)
class LoadedFuzz:
    run: RunRow
    run_scenario: RunScenarioRow
    bundle: BundleRow
    manifest: BundleManifest
    environment: ResolvedEnvironment


def skipped(reason: SkipReason, detail: str) -> RunSchemathesisResult:
    return RunSchemathesisResult(cases_run=0, failures=[], skip_reason=reason, detail=detail)


def parse_manifest(bundle: BundleRow) -> BundleManifest:
    try:
        return BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        raise permanent(f"bundle {bundle.id} has no valid manifest", MANIFEST_INVALID) from None


def adapter_skip_reason(error: AdapterError) -> SkipReason:
    if isinstance(error, InterfaceUnresolvedError | MissingPlaceholderError):
        return SkipReason.env_missing
    return SkipReason.role_unavailable


def cookie_header(cookies: dict[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def run_detail(outcome: FuzzOutcome, unrecorded: int, context: AdapterContext) -> str | None:
    parts: list[str] = []
    explanation = STOP_EXPLANATIONS.get(outcome.stop)
    if explanation is not None:
        parts.append(explanation)
    parts.extend(outcome.notes)
    if unrecorded:
        parts.append(f"{unrecorded} more failures were not stored as steps")
    if not parts:
        return None
    return safe_message("; ".join(parts), context.redactor, DETAIL_LIMIT)


class SchemathesisActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        vault: Vault,
        bundles: BundleStore,
        events: EventClient,
        heartbeat_interval_seconds: float = FUZZ_HEARTBEAT_SECONDS,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.vault = vault
        self.bundles = bundles
        self.events = events
        self.heartbeat_interval_seconds = heartbeat_interval_seconds

    @activity.defn(name=PREPARE_FUZZ_FAMILY_ACTIVITY)
    async def prepare_fuzz_family(self, request: PrepareFuzzFamilyInput) -> PrepareFuzzFamilyResult:
        async with self.session_factory() as session:
            prepared = await self.prepare(session, request.run_id)
            await session.commit()
        if prepared.events:
            await self.events.deliver_all(prepared.events)
        return prepared.result

    def nothing_to_fuzz(self, notice: str | None, ref: str | None = None) -> Prepared:
        result = PrepareFuzzFamilyResult(
            roles=[],
            openapi_ref=ref,
            timeout_seconds=self.settings.fuzz_timeout_seconds,
            notice=notice,
        )
        return Prepared(result, [])

    async def prepare(self, session: AsyncSession, run_id: uuid.UUID) -> Prepared:
        run = await session.get(RunRow, run_id)
        if run is None:
            raise permanent(f"run {run_id} does not exist", RUN_NOT_FOUND)
        plan = None if run.plan_id is None else await session.get(PlanRow, run.plan_id)
        bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
        if plan is None or bundle is None or not plan.include_api_fuzz or bundle.manifest is None:
            return self.nothing_to_fuzz(None)
        manifest = parse_manifest(bundle)
        interface = first_http_interface(manifest)
        if interface is None:
            return self.nothing_to_fuzz(NO_HTTP_INTERFACE)
        roles = fuzz_roles(manifest, PlanSelection.model_validate(plan.selection))
        if not roles:
            return self.nothing_to_fuzz(NO_ROLES)
        ref = bundle_openapi_ref(bundle)
        missing = None if ref is not None else f"bundle v{bundle.version} has no openapi.json"
        await lock_fuzz_scenarios(session, bundle.target_id)
        view = await scenario_view_for_bundle(session, bundle.target_id, bundle.id)
        targets: list[FuzzRoleTarget] = []
        events: list[IngestEvent] = []
        for role in roles:
            stored = await ensure_fuzz_scenario(session, bundle, view, role, interface.id)
            reason = missing or (None if stored.runnable else stored.invalid_reason())
            slot = await ensure_run_scenario(
                session, run.id, stored, None if reason is None else (PRECONDITION_SKIP, reason)
            )
            events.extend(slot.events)
            if reason is None and slot.row.status is RunScenarioStatus.queued:
                targets.append(
                    FuzzRoleTarget(
                        role=role, interface_id=interface.id, run_scenario_id=slot.row.id
                    )
                )
        notice = f"api fuzz skipped: {missing}" if missing is not None else None
        result = PrepareFuzzFamilyResult(
            roles=targets,
            openapi_ref=ref,
            timeout_seconds=self.settings.fuzz_timeout_seconds,
            notice=notice,
        )
        return Prepared(result, events)

    @activity.defn(name=RUN_SCHEMATHESIS_ACTIVITY)
    async def run_schemathesis(self, request: RunSchemathesisInput) -> RunSchemathesisResult:
        loaded = await self.load(request)
        interface_id = loaded.run_scenario.interface_id
        try:
            context = build_adapter_context(
                loaded.manifest,
                loaded.environment,
                request.role,
                interface_id,
                AdapterLimits.from_settings(self.settings, FUZZ_REQUEST_TIMEOUT_SECONDS),
            )
            headers = await self.credentials(context)
        except AdapterError as error:
            redactor = loaded.environment.new_redactor()
            return skipped(
                adapter_skip_reason(error), safe_message(str(error), redactor, MESSAGE_LIMIT)
            )
        try:
            document = await read_openapi_document(self.bundles, loaded.bundle, request.openapi_ref)
        except OpenApiUnavailableError as error:
            return skipped(PRECONDITION_SKIP, str(error))
        config = self.run_config(loaded, context, headers, document, request)
        return await self.fuzz(loaded, context, config, document)

    async def load(self, request: RunSchemathesisInput) -> LoadedFuzz:
        async with self.session_factory() as session:
            run = await session.get(RunRow, request.run_id)
            run_scenario = await session.get(RunScenarioRow, request.run_scenario_id)
            if run is None:
                raise permanent(f"run {request.run_id} does not exist", RUN_NOT_FOUND)
            if run_scenario is None or run_scenario.run_id != run.id:
                raise permanent(
                    f"run scenario {request.run_scenario_id} is not part of run {run.id}",
                    NOT_IN_RUN,
                )
            bundle = None if run.bundle_id is None else await session.get(BundleRow, run.bundle_id)
            if bundle is None or run.target_id is None:
                raise permanent(f"run {run.id} has no bundle or target", MANIFEST_INVALID)
            manifest = parse_manifest(bundle)
            environment = await load_environment(session, self.vault, run.target_id)
            override = await read_base_url_override(session, run.id)
        try:
            environment = override_environment(manifest, environment, override)
        except OverrideNotApplicableError as error:
            raise permanent(str(error), OVERRIDE_NOT_APPLICABLE) from None
        return LoadedFuzz(run, run_scenario, bundle, manifest, environment)

    async def credentials(self, context: AdapterContext) -> dict[str, str]:
        adapter = HttpAdapter(context)
        try:
            identity = await adapter.authenticated_identity(None)
        finally:
            await adapter.close()
        headers = dict(identity.headers)
        if identity.cookies:
            headers["Cookie"] = cookie_header(dict(identity.cookies))
        return headers

    def run_config(
        self,
        loaded: LoadedFuzz,
        context: AdapterContext,
        headers: dict[str, str],
        document: dict[str, Any],
        request: RunSchemathesisInput,
    ) -> FuzzRunConfig:
        declares = declares_base_path(document)
        settings = self.settings
        writes_allowed = settings.fuzz_allow_writes and not loaded.run.read_only
        return FuzzRunConfig(
            origin=context.interface.origin if declares else None,
            base_url=None if declares else context.interface.base_url,
            headers=headers,
            seed=derive_seed(request.run_id, request.role),
            max_examples=settings.fuzz_max_examples,
            max_seconds=max(
                settings.fuzz_timeout_seconds - ENGINE_TIME_MARGIN_SECONDS, MIN_ENGINE_SECONDS
            ),
            request_timeout_seconds=FUZZ_REQUEST_TIMEOUT_SECONDS,
            max_failures=MAX_FUZZ_FAILURES,
            safe_methods_only=not writes_allowed,
            read_limit_bytes=context.limits.max_payload_bytes
            + context.redactor.max_secret_length
            + 1,
        )

    async def fuzz(
        self,
        loaded: LoadedFuzz,
        context: AdapterContext,
        config: FuzzRunConfig,
        document: dict[str, Any],
    ) -> RunSchemathesisResult:
        try:
            outcome = await self.execute_engine(document, config)
        except FuzzSetupError as error:
            return skipped(
                PRECONDITION_SKIP, safe_message(str(error), context.redactor, MESSAGE_LIMIT)
            )
        if (
            outcome.stop is FuzzStop.server_unavailable
            and outcome.cases_run == 0
            and not outcome.failures
        ):
            detail = run_detail(outcome, 0, context) or STOP_EXPLANATIONS[outcome.stop]
            return skipped(SkipReason.service_down, detail)
        step_context = StepContext(
            run_id=loaded.run.id,
            run_scenario_id=loaded.run_scenario.id,
            redactor=context.redactor,
            payload_limit_bytes=context.limits.max_payload_bytes,
            target_url=config.base_url or config.origin or "",
        )
        events, unrecorded = await store_steps(self.session_factory, step_context, outcome)
        await self.events.deliver_all(events)
        logger.info(
            "fuzz_role_finished",
            extra={
                "run_id": str(loaded.run.id),
                "role": loaded.run_scenario.role,
                "cases": outcome.cases_run,
                "failures": len(outcome.failures),
                "stop": outcome.stop.value,
            },
        )
        return RunSchemathesisResult(
            cases_run=outcome.cases_run,
            failures=[
                fuzz_failure_of(failure, context.redactor, outcome.seed)
                for failure in outcome.failures[:MAX_REPORTED_FAILURES]
            ],
            detail=run_detail(outcome, unrecorded, context),
        )

    async def execute_engine(self, document: dict[str, Any], config: FuzzRunConfig) -> FuzzOutcome:
        cancel = threading.Event()
        progress = FuzzProgress()
        engine = asyncio.create_task(
            asyncio.to_thread(run_fuzz, dict(document), config, cancel, progress)
        )
        async with heartbeating(
            self.heartbeat_interval_seconds,
            lambda: {"cases": progress.cases, "failures": progress.failures},
        ):
            try:
                return await asyncio.shield(engine)
            except asyncio.CancelledError:
                cancel.set()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(asyncio.shield(engine), CANCEL_GRACE_SECONDS)
                raise
