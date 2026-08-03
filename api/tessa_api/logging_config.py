import json
import logging
import re
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

REDACTED = "[redacted]"
SENSITIVE_SUFFIXES = frozenset(
    {"password", "passwd", "secret", "token", "authorization", "value", "set"}
)
SENSITIVE_NAMES = frozenset(
    {
        "service_key",
        "signing_key",
        "api_key",
        "ticket",
        "x-service-key",
        "slack_webhook_url",
        "access_key",
        "secret_key",
    }
)
BEARER_PATTERN = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]+")
DSN_PASSWORD_PATTERN = re.compile(r"(\b[a-z][a-z0-9+.-]*://[^:/\s@]+:)[^@\s]+@")
SLACK_WEBHOOK_PATTERN = re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+")
URL_LOGGING_CLIENT_LOGGERS = ("httpx", "httpcore")
RESERVED_RECORD_ATTRIBUTES = frozenset(
    {
        *logging.makeLogRecord({}).__dict__,
        "message",
        "asctime",
        "taskName",
    }
)

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
run_id_var: ContextVar[str | None] = ContextVar("run_id", default=None)
workflow_id_var: ContextVar[str | None] = ContextVar("workflow_id", default=None)
activity_var: ContextVar[str | None] = ContextVar("activity", default=None)


def current_request_id() -> str:
    return request_id_var.get() or "unknown"


@contextmanager
def bound_log_context(
    run_id: str | None, workflow_id: str | None, activity: str | None
) -> Iterator[None]:
    previous = (run_id_var.get(), workflow_id_var.get(), activity_var.get())
    run_id_var.set(run_id)
    workflow_id_var.set(workflow_id)
    activity_var.set(activity)
    try:
        yield
    finally:
        run_id_var.set(previous[0])
        workflow_id_var.set(previous[1])
        activity_var.set(previous[2])


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    if lowered in SENSITIVE_NAMES:
        return True
    return lowered.replace("-", "_").split("_")[-1] in SENSITIVE_SUFFIXES


def redact_text(text: str) -> str:
    masked = BEARER_PATTERN.sub(rf"\1 {REDACTED}", text)
    masked = SLACK_WEBHOOK_PATTERN.sub(REDACTED, masked)
    return DSN_PASSWORD_PATTERN.sub(rf"\1{REDACTED}@", masked)


def redact_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): REDACTED if is_sensitive_key(str(key)) else redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple | set | frozenset):
        return [redact_value(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


class RedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact_text(record.getMessage())
        record.args = None
        for key in set(record.__dict__) - RESERVED_RECORD_ATTRIBUTES:
            current = record.__dict__[key]
            record.__dict__[key] = REDACTED if is_sensitive_key(key) else redact_value(current)
        if record.exc_info and record.exc_info[1] is not None:
            record.exc_text = redact_text(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_var.get(),
            "run_id": run_id_var.get(),
            "workflow_id": workflow_id_var.get(),
            "activity": activity_var.get(),
        }
        for key in sorted(record.__dict__.keys() - RESERVED_RECORD_ATTRIBUTES):
            entry[key] = record.__dict__[key]
        if record.exc_text:
            entry["exception"] = record.exc_text
        return json.dumps(entry, default=str, ensure_ascii=False)


def build_handler() -> logging.Handler:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactionFilter())
    handler.set_name("tessa-json")
    return handler


def configure_logging(level: str) -> None:
    root = logging.getLogger()
    for existing in [
        handler for handler in root.handlers if handler.get_name() == "tessa-json"
    ]:
        root.removeHandler(existing)
    root.addHandler(build_handler())
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        framework_logger = logging.getLogger(name)
        framework_logger.handlers.clear()
        framework_logger.propagate = True
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    for name in URL_LOGGING_CLIENT_LOGGERS:
        client_logger = logging.getLogger(name)
        if client_logger.getEffectiveLevel() < logging.WARNING:
            client_logger.setLevel(logging.WARNING)
