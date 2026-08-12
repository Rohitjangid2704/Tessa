import logging
from dataclasses import dataclass

from prometheus_client import CollectorRegistry, Counter, start_http_server

from tessa_api.metrics import render_registry
from tessa_api.schemas.enums import ModelCallRole, ModelCallStatus, RunKind, RunStatus

logger = logging.getLogger("tessa_worker.metrics")

LISTEN_ADDRESS = "0.0.0.0"


@dataclass(frozen=True, slots=True)
class WorkerMetrics:
    registry: CollectorRegistry
    model_calls: Counter
    model_spend_usd: Counter
    runs_started: Counter
    runs_finished: Counter

    def count_model_call(
        self, role: ModelCallRole, status: ModelCallStatus, cost_usd: float
    ) -> None:
        self.model_calls.labels(role=role.value, status=status.value).inc()
        if cost_usd > 0:
            self.model_spend_usd.labels(role=role.value).inc(cost_usd)

    def count_run_started(self, kind: RunKind) -> None:
        self.runs_started.labels(kind=kind.value).inc()

    def count_run_finished(self, status: RunStatus) -> None:
        self.runs_finished.labels(status=status.value).inc()

    def render(self) -> bytes:
        return render_registry(self.registry)


def build_worker_metrics() -> WorkerMetrics:
    registry = CollectorRegistry(auto_describe=True)
    return WorkerMetrics(
        registry=registry,
        model_calls=Counter(
            "tessa_worker_model_calls_total",
            "Model calls recorded by the worker, by role and outcome",
            ["role", "status"],
            registry=registry,
        ),
        model_spend_usd=Counter(
            "tessa_worker_model_spend_usd_total",
            "Money charged to run budgets by model calls, in USD, by role",
            ["role"],
            registry=registry,
        ),
        runs_started=Counter(
            "tessa_worker_runs_started_total",
            "Runs that left the queued status in this worker, by kind",
            ["kind"],
            registry=registry,
        ),
        runs_finished=Counter(
            "tessa_worker_runs_finished_total",
            "Runs that reached a terminal status in this worker, by status",
            ["status"],
            registry=registry,
        ),
    )


WORKER_METRICS = build_worker_metrics()


def serve_worker_metrics(port: int) -> None:
    start_http_server(port, addr=LISTEN_ADDRESS, registry=WORKER_METRICS.registry)
    logger.info("worker_metrics_listening", extra={"port": port})
