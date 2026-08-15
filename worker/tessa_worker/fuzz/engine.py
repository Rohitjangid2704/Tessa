import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import schemathesis
from schemathesis.config import ConfigError, SchemathesisConfig
from schemathesis.core.result import Ok
from schemathesis.core.transport import Response
from schemathesis.engine import Status, StopReason, events, from_schema
from schemathesis.engine.recorder import CheckNode, Request, ScenarioRecorder
from schemathesis.errors import SchemathesisError
from schemathesis.schemas import BaseSchema

from tessa_worker.fuzz.checks import FUZZ_CHECKS, SAFE_METHODS
from tessa_worker.fuzz.models import (
    CapturedRequest,
    CapturedResponse,
    CollectedFailure,
    FuzzOutcome,
    FuzzRunConfig,
    FuzzStop,
)

MAX_NOTES = 10
NOTE_LIMIT = 300
SECONDS_TO_MS = 1000
STOP_REASONS: Mapping[StopReason, FuzzStop] = {
    StopReason.COMPLETED: FuzzStop.completed,
    StopReason.INTERRUPTED: FuzzStop.interrupted,
    StopReason.FAILURE_LIMIT: FuzzStop.failure_limit,
    StopReason.MAX_TIME: FuzzStop.time_limit,
    StopReason.SERVER_UNAVAILABLE: FuzzStop.server_unavailable,
}


class FuzzSetupError(Exception):
    pass


@dataclass(slots=True)
class FuzzProgress:
    cases: int = 0
    failures: int = 0


def first_line(error: BaseException) -> str:
    lines = str(error).strip().splitlines()
    text = lines[0] if lines else type(error).__name__
    return text[:NOTE_LIMIT]


def config_data(run: FuzzRunConfig) -> dict[str, Any]:
    data: dict[str, Any] = {
        "seed": run.seed,
        "max-time": run.max_seconds,
        "max-failures": run.max_failures,
        "headers": dict(run.headers),
        "workers": 1,
        "request-timeout": run.request_timeout_seconds,
        "generation": {
            "max-examples": run.max_examples,
            "database": "none",
            "with-security-parameters": False,
        },
        "checks": {"enabled": False, **{name: {"enabled": True} for name in FUZZ_CHECKS}},
        "phases": {"coverage": {"enabled": False}, "stateful": {"enabled": False}},
    }
    if run.base_url is not None:
        data["base-url"] = run.base_url
    elif run.origin is not None:
        data["origin"] = run.origin
    return data


def build_config(run: FuzzRunConfig) -> SchemathesisConfig:
    try:
        return SchemathesisConfig.from_dict(config_data(run))
    except ConfigError as error:
        raise FuzzSetupError(f"the fuzz configuration is invalid: {first_line(error)}") from None


def load_schema(
    document: dict[str, Any], config: SchemathesisConfig, safe_methods_only: bool
) -> BaseSchema:
    try:
        schema: BaseSchema = schemathesis.openapi.from_dict(document, config=config)
    except SchemathesisError as error:
        raise FuzzSetupError(
            f"the OpenAPI document cannot be loaded: {first_line(error)}"
        ) from None
    if safe_methods_only:
        schema = schema.include(method=list(SAFE_METHODS))
    return schema


def operation_labels(schema: BaseSchema) -> list[str]:
    return [item.ok().label for item in schema.get_all_operations() if isinstance(item, Ok)]


def joined_headers(headers: Mapping[str, list[str]]) -> dict[str, str]:
    return {name: ", ".join(values) for name, values in headers.items()}


def capture_request(request: Request, limit: int) -> CapturedRequest:
    body = request.body
    return CapturedRequest(
        method=request.method,
        url=request.uri,
        headers=joined_headers(request.headers),
        body=None if body is None else body[:limit],
    )


def capture_response(response: Response, limit: int) -> CapturedResponse:
    content = response.content
    return CapturedResponse(
        status_code=response.status_code,
        headers=joined_headers(response.headers),
        content=content[:limit],
        truncated=len(content) > limit or response.content_size > len(content),
        elapsed_ms=round(response.elapsed * SECONDS_TO_MS),
    )


@dataclass(slots=True)
class FailureSlot:
    failure: CollectedFailure
    final: bool


@dataclass(slots=True)
class OutcomeCollector:
    config: FuzzRunConfig
    progress: FuzzProgress
    operations: set[str] = field(default_factory=set)
    failures: dict[tuple[str, str, str], FailureSlot] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    stop: FuzzStop = FuzzStop.completed

    def note(self, text: str) -> None:
        if text and text not in self.notes and len(self.notes) < MAX_NOTES:
            self.notes.append(text)

    def handle(self, event: events.EngineEvent) -> None:
        if isinstance(event, events.ScenarioFinished):
            self.record(event.recorder, event.is_final)
        elif isinstance(event, events.FuzzScenarioFinished):
            self.record(event.recorder, False)
        elif isinstance(event, events.NonFatalError):
            self.note(f"{event.label}: {first_line(event.value)}")
        elif isinstance(event, events.FatalError):
            self.note(f"the engine failed: {first_line(event.exception)}")
            self.stop = FuzzStop.engine_failed
        elif isinstance(event, events.EngineFinished):
            self.finish(event)

    def finish(self, event: events.EngineFinished) -> None:
        if self.stop is FuzzStop.engine_failed:
            return
        self.stop = STOP_REASONS.get(event.stop_reason, FuzzStop.interrupted)

    def record(self, recorder: ScenarioRecorder, is_final: bool) -> None:
        self.progress.cases += len(recorder.cases)
        for case_node in recorder.cases.values():
            self.operations.add(case_node.value.operation.label)
        for case_id, check_nodes in recorder.checks.items():
            for check_node in check_nodes:
                if check_node.status is Status.FAILURE and check_node.failure_info is not None:
                    self.add_failure(recorder, case_id, check_node, is_final)

    def add_failure(
        self, recorder: ScenarioRecorder, case_id: str, node: CheckNode, is_final: bool
    ) -> None:
        if node.failure_info is None:
            return
        failure = node.failure_info.failure
        failing_case_id = failure.case_id if failure.case_id in recorder.cases else case_id
        case_node = recorder.cases.get(failing_case_id)
        operation = failure.operation or (
            case_node.value.operation.label if case_node is not None else "unknown operation"
        )
        key = (operation, node.name, failure.title)
        known = self.failures.get(key)
        if known is not None and (known.final or not is_final):
            return
        interaction = recorder.interactions.get(failing_case_id)
        limit = self.config.read_limit_bytes
        collected = CollectedFailure(
            operation=operation,
            check=node.name,
            title=failure.title,
            message=failure.message,
            request=None if interaction is None else capture_request(interaction.request, limit),
            response=(
                None
                if interaction is None or interaction.response is None
                else capture_response(interaction.response, limit)
            ),
        )
        self.failures[key] = FailureSlot(collected, is_final)
        self.progress.failures = len(self.failures)

    def outcome(self, operations: int, started: float) -> FuzzOutcome:
        return FuzzOutcome(
            cases_run=self.progress.cases,
            operations=max(operations, len(self.operations)),
            failures=[slot.failure for slot in self.failures.values()],
            notes=list(self.notes),
            stop=self.stop,
            seed=self.config.seed,
            elapsed_ms=round((time.monotonic() - started) * SECONDS_TO_MS),
        )


def run_fuzz(
    document: dict[str, Any],
    run: FuzzRunConfig,
    cancel: threading.Event,
    progress: FuzzProgress,
) -> FuzzOutcome:
    started = time.monotonic()
    schema = load_schema(document, build_config(run), run.safe_methods_only)
    operations = operation_labels(schema)
    if not operations:
        raise FuzzSetupError(
            "the OpenAPI document declares no operation that may be fuzzed"
            + (" with a safe method" if run.safe_methods_only else "")
        )
    collector = OutcomeCollector(run, progress)
    stream = from_schema(schema).execute()
    try:
        for event in stream:
            collector.handle(event)
            if cancel.is_set():
                stream.stop()
            if event.is_terminal:
                break
    except Exception as error:
        collector.note(f"the engine stopped: {type(error).__name__}: {first_line(error)}")
        collector.stop = FuzzStop.engine_failed
    return collector.outcome(len(operations), started)
