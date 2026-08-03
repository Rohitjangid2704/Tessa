import time
from collections.abc import MutableMapping
from typing import Any

from prometheus_client import CollectorRegistry, Counter, Histogram, generate_latest
from starlette.types import ASGIApp, Message, Receive, Scope, Send

PROMETHEUS_MEDIA_TYPE = "text/plain; version=0.0.4"
UNMATCHED_ROUTE = "unmatched"
FALLBACK_STATUS_CODE = 500
LATENCY_BUCKETS_SECONDS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)


def render_registry(registry: CollectorRegistry) -> bytes:
    return generate_latest(registry)


class ApiMetrics:
    def __init__(self) -> None:
        self.registry = CollectorRegistry(auto_describe=True)
        self.http_requests = Counter(
            "tessa_api_http_requests_total",
            "HTTP requests handled by the api process",
            ["method", "route", "status"],
            registry=self.registry,
        )
        self.http_latency = Histogram(
            "tessa_api_http_request_duration_seconds",
            "HTTP request duration of the api process in seconds",
            ["method", "route"],
            buckets=LATENCY_BUCKETS_SECONDS,
            registry=self.registry,
        )

    def observe_request(self, method: str, route: str, status_code: int, seconds: float) -> None:
        self.http_requests.labels(method=method, route=route, status=str(status_code)).inc()
        self.http_latency.labels(method=method, route=route).observe(seconds)

    def render(self) -> bytes:
        return render_registry(self.registry)


def route_template(scope: MutableMapping[str, Any]) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else UNMATCHED_ROUTE


class MetricsMiddleware:
    def __init__(self, app: ASGIApp, metrics: ApiMetrics) -> None:
        self.app = app
        self.metrics = metrics

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        status_code = FALLBACK_STATUS_CODE

        async def capture_status(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, capture_status)
        finally:
            self.metrics.observe_request(
                scope["method"], route_template(scope), status_code, time.perf_counter() - started
            )
