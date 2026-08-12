import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import httpx
from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.service import RPCError
from temporalio.worker import Worker

from tessa_api.db.session import SessionFactory, create_engine, create_session_factory
from tessa_api.logging_config import configure_logging
from tessa_api.services.artifact_store import ArtifactStore
from tessa_api.services.artifacts import artifact_store_from_settings
from tessa_api.services.storage import BundleStore, bundle_store_from_settings
from tessa_api.services.vault import vault_from_settings
from tessa_worker.activities.adapter_opener import RegistryAdapterOpener
from tessa_worker.activities.browser_session import BrowserSessionActivities
from tessa_worker.activities.clock import default_clock_activities
from tessa_worker.activities.drive import DriveActivities
from tessa_worker.activities.drive_ports import AdapterOpener, StepHooks
from tessa_worker.activities.dry_run import DryRunActivities
from tessa_worker.activities.embed import EmbedActivities
from tessa_worker.activities.events import EventActivities
from tessa_worker.activities.explore import ExploreActivities
from tessa_worker.activities.findings import FindingActivities
from tessa_worker.activities.flakiness import FlakinessActivities
from tessa_worker.activities.grading import GradingActivities
from tessa_worker.activities.invariant_scenarios import InvariantScenarioActivities
from tessa_worker.activities.invariants import InvariantActivities
from tessa_worker.activities.judge import default_judge_activities
from tessa_worker.activities.labels import LabelActivities
from tessa_worker.activities.laya import LayaActivities
from tessa_worker.activities.model_call import DatabaseModelCallRecorder, ModelCallActivities
from tessa_worker.activities.model_call_contracts import ModelCallRecorder
from tessa_worker.activities.model_specs import ModelSpecActivities
from tessa_worker.activities.mutation import MutationActivities
from tessa_worker.activities.notify import NotifyActivities
from tessa_worker.activities.oracle import default_oracle_activities
from tessa_worker.activities.probes import ProbeActivities
from tessa_worker.activities.redteam import default_redteam_activities
from tessa_worker.activities.reports import ReportActivities
from tessa_worker.activities.retention import RetentionActivities
from tessa_worker.activities.run_config import RunConfigActivities
from tessa_worker.activities.run_context import RunContextActivities
from tessa_worker.activities.run_status import RunStatusActivities
from tessa_worker.activities.scenario_import import ScenarioImportActivities
from tessa_worker.activities.scenario_lifecycle import ScenarioLifecycleActivities
from tessa_worker.activities.scenarios import ScenarioPlanningActivities
from tessa_worker.activities.schedule_run import ScheduleRunActivities
from tessa_worker.activities.schemathesis import SchemathesisActivities
from tessa_worker.activities.seed_gate import SeedGateActivities
from tessa_worker.activities.seeding import SeedingActivities
from tessa_worker.activities.session_queue import SessionQueue, SessionQueueActivities
from tessa_worker.activities.simulate import default_simulation_activities
from tessa_worker.activities.tier0 import Tier0Activities
from tessa_worker.activities.truth_hooks import default_truth_hooks
from tessa_worker.activities.verify import VerifyActivities
from tessa_worker.adapters.browser import BrowserRuntime
from tessa_worker.adapters.browser_session.opening import ExplorerSessions
from tessa_worker.adapters.registry import default_registry
from tessa_worker.checks.tier0 import evaluate_tier0
from tessa_worker.event_client import EventClient
from tessa_worker.findings.embedding_client import EmbeddingProviders, KeyedEmbeddingProviders
from tessa_worker.grading.judge_providers import JudgeProviders, ProviderKeys
from tessa_worker.live.uplink import FrameUplink
from tessa_worker.log_context import LogContextInterceptor
from tessa_worker.metrics import serve_worker_metrics
from tessa_worker.reports.builder import ReportBuilder
from tessa_worker.settings import WorkerSettings, load_settings
from tessa_worker.testing.stub_models import StubModelRegistry
from tessa_worker.workflows import WORKFLOWS

CONNECT_RETRY_START_SECONDS = 1.0
CONNECT_RETRY_MAX_SECONDS = 10.0
HEARTBEAT_THROTTLE = timedelta(seconds=2)

logger = logging.getLogger("tessa_worker")


@dataclass(frozen=True, slots=True)
class WorkerServices:
    settings: WorkerSettings
    api_http: httpx.AsyncClient
    laya_http: httpx.AsyncClient
    session_factory: SessionFactory
    adapters: AdapterOpener
    artifacts: ArtifactStore
    bundles: BundleStore
    hooks: StepHooks | None = None
    judge_providers: JudgeProviders | None = None
    stub_models: StubModelRegistry | None = None
    model_calls: ModelCallRecorder | None = None
    embedding_providers: EmbeddingProviders | None = None


def explorer_sessions_of(services: WorkerServices) -> ExplorerSessions:
    return ExplorerSessions(
        services.settings,
        services.session_factory,
        services.adapters,
        services.artifacts,
        services.bundles,
        vault_from_settings(services.settings),
    )


def build_activities(services: WorkerServices) -> list[Callable[..., Any]]:
    settings = services.settings
    events = EventClient(settings, services.api_http)
    model_calls = services.model_calls or DatabaseModelCallRecorder(services.session_factory)
    run_status = RunStatusActivities(services.session_factory, events)
    lifecycle = ScenarioLifecycleActivities(services.session_factory, events)
    planning = ScenarioPlanningActivities(services.session_factory, services.bundles, events)
    drive = DriveActivities(
        settings,
        services.session_factory,
        events,
        services.adapters,
        services.artifacts,
        evaluate_tier0,
        services.hooks,
    )
    seeding = SeedingActivities(
        settings, services.session_factory, vault_from_settings(settings), services.bundles
    )
    judge = default_judge_activities(
        settings,
        services.session_factory,
        services.judge_providers,
        services.stub_models,
        model_calls,
    )
    oracle = default_oracle_activities(settings, services.session_factory)
    clock = default_clock_activities(settings, services.session_factory)
    grading = GradingActivities(
        settings, services.session_factory, events, vault_from_settings(settings)
    )
    seed_gate = SeedGateActivities(services.session_factory)
    run_config = RunConfigActivities(settings, services.session_factory, clock.resolver)
    embed = EmbedActivities(
        settings,
        model_calls,
        services.embedding_providers
        or KeyedEmbeddingProviders(
            ProviderKeys(services.session_factory, vault_from_settings(settings), settings)
        ),
    )
    findings = FindingActivities(settings, services.session_factory, events, services.laya_http)
    dry_run = DryRunActivities(settings, services.session_factory, events)
    probes = ProbeActivities(settings, services.session_factory, services.laya_http)
    invariants = InvariantActivities(settings, services.session_factory, events, probes)
    simulation = default_simulation_activities(
        settings,
        services.session_factory,
        events,
        services.adapters,
        oracle.checks,
        invariants.evaluate_invariants,
        judge,
    )
    redteam = default_redteam_activities(settings, services.session_factory, events, probes, judge)
    explorer_sessions = explorer_sessions_of(services)
    explore = ExploreActivities(services.session_factory)
    verify = VerifyActivities(
        settings, services.session_factory, events, explorer_sessions, lifecycle
    )
    session_queue = SessionQueueActivities(SessionQueue.for_process(settings))
    invariant_scenarios = InvariantScenarioActivities(settings, services.session_factory, events)
    schemathesis = SchemathesisActivities(
        settings,
        services.session_factory,
        vault_from_settings(settings),
        services.bundles,
        events,
    )
    reports = ReportActivities(ReportBuilder(settings, services.session_factory))
    retention = RetentionActivities(settings, services.session_factory)
    notify = NotifyActivities(
        settings, services.session_factory, events, vault_from_settings(settings)
    )
    schedule_run = ScheduleRunActivities(settings, services.api_http, services.session_factory)
    mutation = MutationActivities(
        settings, services.session_factory, vault_from_settings(settings), events
    )
    return [
        EventActivities(settings, services.api_http).emit_run_event,
        LayaActivities(settings, services.laya_http).laya_smoke_call,
        RunContextActivities(services.session_factory, settings).load_run_context,
        run_status.update_run_status,
        run_status.finalize_run,
        run_status.publish_run_progress,
        lifecycle.begin_scenario_attempt,
        lifecycle.record_scenario_attempt,
        lifecycle.finish_run_scenario,
        lifecycle.skip_run_scenarios,
        lifecycle.skip_ungraded_steps,
        planning.expand_cells,
        planning.generate_smoke_scenario,
        planning.validate_scenario,
        planning.create_run_scenarios,
        run_config.freeze_run_config,
        seed_gate.plan_seed_assertion,
        seed_gate.assert_seed,
        seeding.load_seed_material,
        seeding.open_seed_run,
        seeding.execute_reset_script,
        seeding.run_hash_command,
        seeding.record_seed_outcome,
        drive.drive_scenario_attempt,
        Tier0Activities(services.session_factory).run_tier0_checks,
        probes.run_laya_probes,
        invariants.evaluate_invariants,
        invariant_scenarios.ensure_invariant_scenarios,
        judge.build_step_evidence,
        judge.judge_step,
        judge.judge_tiebreak,
        grading.load_step_grading,
        grading.list_attempt_steps,
        grading.record_step_grade,
        grading.resolve_grade_policy,
        LabelActivities(services.session_factory).store_weak_label,
        oracle.execute_oracle_query,
        oracle.render_expected_sentence,
        oracle.fail_oracle_result,
        oracle.resolve_gold_points,
        oracle.check_db_expectation,
        clock.resolve_clock,
        ModelCallActivities(model_calls).record_model_call,
        ModelSpecActivities(settings, services.session_factory).resolve_model_specs,
        embed.embed_texts,
        findings.fingerprint_findings,
        findings.dedupe_findings,
        findings.upsert_findings,
        findings.build_repro_bundle,
        findings.resolve_findings,
        FlakinessActivities(settings, services.session_factory, events).apply_flakiness_policy,
        dry_run.load_dry_run_context,
        dry_run.prepare_dry_run,
        dry_run.dry_run_scenario,
        dry_run.skip_dry_run,
        ScenarioImportActivities(
            services.session_factory, services.bundles, events
        ).import_authored_scenarios,
        schemathesis.prepare_fuzz_family,
        schemathesis.run_schemathesis,
        simulation.send_target_turn,
        simulation.check_simulation,
        redteam.prepare_attack,
        redteam.assess_attack,
        redteam.prepare_attack_replays,
        redteam.skeptic_verify,
        redteam.settle_attack,
        session_queue.get_worker_task_queue,
        explore.settle_pending_candidates,
        verify.verify_by_replay,
        mutation.prepare_mutation_run,
        mutation.verify_deployed_marker,
        mutation.resolve_baseline_run,
        mutation.score_mutation,
        mutation.close_mutation_run,
        schedule_run.create_scheduled_run,
        schedule_run.load_scheduled_run_outcome,
        reports.render_report,
        retention.load_retention_plan,
        retention.purge_step_payloads,
        retention.purge_artifacts,
        retention.purge_run_events,
        retention.record_retention_sweep,
        notify.create_notification,
        notify.evaluate_notifications,
        notify.send_slack,
    ]


def build_session_activities(services: WorkerServices) -> BrowserSessionActivities:
    return BrowserSessionActivities(
        services.session_factory,
        EventClient(services.settings, services.api_http),
        explorer_sessions_of(services),
    )


def build_worker(client: Client, services: WorkerServices) -> Worker:
    return Worker(
        client,
        task_queue=services.settings.temporal_task_queue,
        workflows=WORKFLOWS,
        activities=build_activities(services),
        max_concurrent_activities=services.settings.worker_max_concurrent_activities,
        max_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
        default_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
        interceptors=[LogContextInterceptor()],
    )


def build_session_worker(
    client: Client, services: WorkerServices, sessions: BrowserSessionActivities
) -> Worker:
    return Worker(
        client,
        task_queue=SessionQueue.for_process(services.settings).name,
        activities=[
            sessions.open_browser_session,
            sessions.close_browser_session,
            sessions.execute_action,
        ],
        max_concurrent_activities=services.settings.worker_max_concurrent_activities,
        max_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
        default_heartbeat_throttle_interval=HEARTBEAT_THROTTLE,
        interceptors=[LogContextInterceptor()],
    )


async def connect_with_retry(settings: WorkerSettings) -> Client:
    delay = CONNECT_RETRY_START_SECONDS
    while True:
        try:
            return await Client.connect(
                settings.temporal_address,
                namespace=settings.temporal_namespace,
                data_converter=pydantic_data_converter,
            )
        except (RuntimeError, OSError, RPCError) as error:
            logger.warning(
                "temporal_unreachable_retrying",
                extra={
                    "address": settings.temporal_address,
                    "error": type(error).__name__,
                    "retry_in_seconds": delay,
                },
            )
            await asyncio.sleep(delay)
            delay = min(delay * 2, CONNECT_RETRY_MAX_SECONDS)


def default_services(
    settings: WorkerSettings,
    api_http: httpx.AsyncClient,
    laya_http: httpx.AsyncClient,
    session_factory: SessionFactory,
    browser: BrowserRuntime | None = None,
) -> WorkerServices:
    return WorkerServices(
        settings=settings,
        api_http=api_http,
        laya_http=laya_http,
        session_factory=session_factory,
        adapters=RegistryAdapterOpener(
            session_factory, vault_from_settings(settings), default_registry(), settings, browser
        ),
        artifacts=artifact_store_from_settings(settings),
        bundles=bundle_store_from_settings(settings),
        hooks=default_truth_hooks(settings, session_factory),
    )


async def start_browser_runtime(settings: WorkerSettings) -> BrowserRuntime | None:
    runtime = BrowserRuntime(settings, FrameUplink(settings))
    try:
        report = await runtime.start()
    except Exception as error:
        logger.error("browser_runtime_unavailable", extra={"error": type(error).__name__})
        await runtime.stop()
        return None
    logger.info("browser_runtime_started", extra={"sweep": str(report)})
    return runtime


@asynccontextmanager
async def open_services(settings: WorkerSettings) -> AsyncIterator[WorkerServices]:
    engine = create_engine(settings.database_url)
    browser = await start_browser_runtime(settings)
    try:
        async with httpx.AsyncClient() as api_http, httpx.AsyncClient() as laya_http:
            yield default_services(
                settings, api_http, laya_http, create_session_factory(engine), browser
            )
    finally:
        if browser is not None:
            await browser.stop()
        await engine.dispose()


async def run(settings: WorkerSettings) -> None:
    if settings.metrics_enabled:
        serve_worker_metrics(settings.metrics_port)
    client = await connect_with_retry(settings)
    async with open_services(settings) as services:
        worker = build_worker(client, services)
        sessions = build_session_activities(services)
        session_worker = build_session_worker(client, services, sessions)
        logger.info(
            "worker_polling",
            extra={
                "address": settings.temporal_address,
                "namespace": settings.temporal_namespace,
                "task_queue": settings.temporal_task_queue,
                "session_task_queue": SessionQueue.for_process(settings).name,
            },
        )
        try:
            async with asyncio.TaskGroup() as group:
                group.create_task(worker.run())
                group.create_task(session_worker.run())
        finally:
            await sessions.close_all()


def main() -> None:
    settings = load_settings()
    configure_logging(settings.log_level)
    try:
        asyncio.run(run(settings))
    except KeyboardInterrupt:
        logger.info("worker_stopped")


if __name__ == "__main__":
    main()
