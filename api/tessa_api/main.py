import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from functools import cache
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.routing import APIRoute
from sqlalchemy.exc import InterfaceError, OperationalError

from tessa_api.auth.users import ensure_bootstrap_admin
from tessa_api.db.session import create_engine, create_session_factory
from tessa_api.errors import register_exception_handlers
from tessa_api.logging_config import configure_logging
from tessa_api.metrics import ApiMetrics, MetricsMiddleware
from tessa_api.middleware import (
    AuditLedgerMiddleware,
    BodySizeGuardMiddleware,
    ErrorBoundaryMiddleware,
    RequestContextMiddleware,
    upload_body_limits,
)
from tessa_api.routers import (
    agent_sessions,
    app_kinds,
    artifacts,
    audit_events,
    auth,
    bundles,
    calibration,
    catalog,
    coverage,
    dashboard,
    environment,
    feeds,
    findings,
    frames,
    health,
    health_checks,
    internal,
    internal_schedules,
    invariants,
    labels,
    limits,
    metrics,
    mutants,
    mutation,
    mutation_runs,
    notifications,
    oracles,
    personal_tokens,
    plans,
    probes,
    prompt_issues,
    prompt_templates,
    proposals,
    root,
    run_scenarios,
    runs,
    scenarios,
    schedules,
    schemas,
    seeds,
    steps,
    system,
    targets,
    trends,
    users,
    ws_tickets,
)
from tessa_api.routers import settings as settings_router
from tessa_api.schemas.streams import stream_client_message_adapter, stream_event_adapter
from tessa_api.services.notifications import HubNotificationEvents
from tessa_api.services.rate_limit import LoginRateLimiter
from tessa_api.services.retention_schedule import run_retention_schedule_setup
from tessa_api.services.schedule_reconcile import run_schedule_reconcile
from tessa_api.services.schema_registry import SchemaStore
from tessa_api.services.tickets import TicketRegistry
from tessa_api.settings import Settings, load_settings
from tessa_api.streams import ws
from tessa_api.streams.feeds import RunDirectory
from tessa_api.streams.hub import Hub
from tessa_api.streams.tiles import tile_policy
from tessa_api.temporal_client import TemporalGateway

API_PREFIX = "/api/v1"
CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
CORS_ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "Last-Event-ID",
    "X-Request-ID",
]
CORS_EXPOSED_HEADERS = [
    "X-Request-ID",
    "Idempotency-Replayed",
    "Retry-After",
    "Content-Disposition",
]
CORS_MAX_AGE_SECONDS = 600
GZIP_MINIMUM_SIZE = 1024
DEFAULT_VALIDATION_SCHEMA = "#/components/schemas/HTTPValidationError"
ERROR_RESPONSE_SCHEMA = "#/components/schemas/ErrorResponse"

logger = logging.getLogger("tessa_api")


def unique_operation_id(route: APIRoute) -> str:
    tag = str(route.tags[0]) if route.tags else "api"
    return f"{tag}_{route.name}".replace("-", "_")


def merge_stream_schemas(components: dict[str, Any]) -> None:
    for name, adapter in (
        ("StreamEvent", stream_event_adapter),
        ("StreamClientMessage", stream_client_message_adapter),
    ):
        generated = adapter.json_schema(ref_template="#/components/schemas/{model}")
        for definition_name, definition in generated.pop("$defs", {}).items():
            components.setdefault(definition_name, definition)
        components[name] = generated


def replace_default_validation_errors(schema: dict[str, Any]) -> None:
    for path_item in schema.get("paths", {}).values():
        for operation in path_item.values():
            if not isinstance(operation, dict):
                continue
            for response in operation.get("responses", {}).values():
                media = response.get("content", {}).get("application/json", {})
                if media.get("schema", {}).get("$ref") == DEFAULT_VALIDATION_SCHEMA:
                    media["schema"] = {"$ref": ERROR_RESPONSE_SCHEMA}
                    response["description"] = "Request validation failed"
    components = schema.get("components", {}).get("schemas", {})
    components.pop("HTTPValidationError", None)
    components.pop("ValidationError", None)


class TessaApp(FastAPI):
    def openapi(self) -> dict[str, Any]:
        if self.openapi_schema is not None:
            return self.openapi_schema
        schema = super().openapi()
        merge_stream_schemas(schema.setdefault("components", {}).setdefault("schemas", {}))
        replace_default_validation_errors(schema)
        return schema


def include_routers(app: FastAPI) -> None:
    app.include_router(root.router)
    app.include_router(health.router)
    app.include_router(schemas.router)
    app.include_router(internal.router)
    app.include_router(internal_schedules.router)
    app.include_router(frames.router)
    app.include_router(ws.router)
    app.include_router(auth.router, prefix=f"{API_PREFIX}/auth")
    app.include_router(users.router, prefix=f"{API_PREFIX}/users")
    app.include_router(ws_tickets.router, prefix=f"{API_PREFIX}/ws-tickets")
    app.include_router(system.router, prefix=f"{API_PREFIX}/system")
    app.include_router(runs.router, prefix=f"{API_PREFIX}/runs")
    for stage_one_router in (
        targets.router,
        app_kinds.router,
        limits.router,
        prompt_templates.router,
        prompt_issues.router,
        bundles.router,
        catalog.router,
        environment.router,
        health_checks.router,
    ):
        app.include_router(stage_one_router, prefix=API_PREFIX)
    for stage_two_router in (
        plans.router,
        scenarios.router,
        run_scenarios.router,
        steps.router,
        artifacts.router,
        feeds.router,
    ):
        app.include_router(stage_two_router, prefix=API_PREFIX)
    app.include_router(labels.router, prefix=f"{API_PREFIX}/labels")
    for stage_three_and_four_router in (
        seeds.router,
        oracles.router,
        probes.router,
        settings_router.router,
    ):
        app.include_router(stage_three_and_four_router, prefix=API_PREFIX)
    app.include_router(metrics.router)
    for stage_five_and_six_router in (
        findings.router,
        invariants.router,
        trends.router,
        coverage.router,
    ):
        app.include_router(stage_five_and_six_router, prefix=API_PREFIX)
    for stage_eight_router in (
        mutants.router,
        mutation_runs.router,
        mutation.router,
        calibration.router,
        schedules.router,
        notifications.router,
        dashboard.router,
    ):
        app.include_router(stage_eight_router, prefix=API_PREFIX)
    for stage_eleven_router in (
        personal_tokens.router,
        audit_events.router,
        agent_sessions.router,
        proposals.router,
    ):
        app.include_router(stage_eleven_router, prefix=API_PREFIX)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    configure_logging(settings.log_level)
    engine = create_engine(settings.database_url)
    session_factory = create_session_factory(engine)
    hub = Hub(tile_policy(settings))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await ensure_bootstrap_admin(session_factory, settings)
        except (ConnectionError, OperationalError, InterfaceError):
            logger.warning("bootstrap_admin_skipped_database_unreachable")
        reconcile = asyncio.create_task(
            run_schedule_reconcile(session_factory, app.state.temporal, HubNotificationEvents(hub)),
            name="schedule-reconcile",
        )
        retention_schedule = asyncio.create_task(
            run_retention_schedule_setup(app.state.temporal), name="retention-schedule"
        )
        try:
            yield
        finally:
            for startup_task in (reconcile, retention_schedule):
                startup_task.cancel()
                with suppress(asyncio.CancelledError):
                    await startup_task
            hub.shutdown()
            await engine.dispose()

    app = TessaApp(
        title="Tessa API",
        version="0.1.0",
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs" if settings.docs_enabled else None,
        redoc_url=None,
        lifespan=lifespan,
        generate_unique_id_function=unique_operation_id,
        separate_input_output_schemas=False,
    )
    api_metrics = ApiMetrics()
    app.state.settings = settings
    app.state.metrics = api_metrics
    app.state.engine = engine
    app.state.session_factory = session_factory
    app.state.login_rate_limiter = LoginRateLimiter()
    app.state.hub = hub
    app.state.run_directory = RunDirectory(session_factory)
    app.state.ticket_registry = TicketRegistry()
    app.state.temporal = TemporalGateway(
        settings.temporal_address, settings.temporal_namespace, settings.temporal_task_queue
    )
    app.state.schema_store = SchemaStore(settings.schemas_dir, settings.public_api_url)
    register_exception_handlers(app)
    app.add_middleware(AuditLedgerMiddleware, session_factory=session_factory)
    app.add_middleware(ErrorBoundaryMiddleware)
    app.add_middleware(BodySizeGuardMiddleware, limits=upload_body_limits(settings))
    app.add_middleware(GZipMiddleware, minimum_size=GZIP_MINIMUM_SIZE)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=CORS_METHODS,
        allow_headers=CORS_ALLOWED_HEADERS,
        expose_headers=CORS_EXPOSED_HEADERS,
        max_age=CORS_MAX_AGE_SECONDS,
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(MetricsMiddleware, metrics=api_metrics)
    include_routers(app)
    return app


@cache
def default_app() -> FastAPI:
    return create_app()


def __getattr__(name: str) -> FastAPI:
    if name == "app":
        return default_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
