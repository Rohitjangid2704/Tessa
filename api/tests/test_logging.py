import io
import json
import logging

import httpx
import pytest

from tessa_api.logging_config import (
    REDACTED,
    JsonFormatter,
    RedactionFilter,
    configure_logging,
    is_sensitive_key,
    redact_value,
    request_id_var,
)


def capture_logger(name: str) -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactionFilter())
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    return logger, stream


def test_sensitive_keys_are_masked_in_extra_fields() -> None:
    logger, stream = capture_logger("test.redaction.extra")
    logger.info(
        "login",
        extra={
            "password": "hunter2",
            "token": "abc",
            "authorization": "Bearer abc.def.ghi",
            "value": "secret value",
            "set": {"NAME": "x"},
            "api_jwt_secret": "s3cr3t",
            "email": "user@example.com",
        },
    )
    entry = json.loads(stream.getvalue())
    for key in ("password", "token", "authorization", "value", "set", "api_jwt_secret"):
        assert entry[key] == REDACTED
    assert entry["email"] == "user@example.com"
    assert "hunter2" not in stream.getvalue()


def test_nested_values_are_masked() -> None:
    masked = redact_value({"outer": {"password": "x", "keep": 1}, "items": [{"secret": "y"}]})
    assert masked == {"outer": {"password": REDACTED, "keep": 1}, "items": [{"secret": REDACTED}]}


def test_bearer_tokens_and_dsn_passwords_are_masked_in_messages() -> None:
    logger, stream = capture_logger("test.redaction.message")
    logger.info("calling with Bearer abc.def.ghi and postgresql://user:pw123@host/db")
    output = stream.getvalue()
    assert "abc.def.ghi" not in output
    assert "pw123" not in output
    assert "postgresql://user:" in output


def test_exception_text_is_masked() -> None:
    logger, stream = capture_logger("test.redaction.exception")
    try:
        raise RuntimeError("connect postgresql://user:pw123@host/db failed")
    except RuntimeError:
        logger.exception("boom")
    entry = json.loads(stream.getvalue())
    assert "pw123" not in entry["exception"]
    assert "RuntimeError" in entry["exception"]


def test_request_id_is_in_every_line() -> None:
    logger, stream = capture_logger("test.redaction.request_id")
    token = request_id_var.set("request-id-0001")
    try:
        logger.info("hello")
    finally:
        request_id_var.reset(token)
    assert json.loads(stream.getvalue())["request_id"] == "request-id-0001"


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("password", True),
        ("Authorization", True),
        ("x-service-key", True),
        ("client_secret", True),
        ("access_token", True),
        ("value", True),
        ("set", True),
        ("input_tokens", False),
        ("settings", False),
        ("path", False),
    ],
)
def test_sensitive_key_detection(key: str, expected: bool) -> None:
    assert is_sensitive_key(key) is expected


def test_configure_logging_is_idempotent() -> None:
    configure_logging("info")
    configure_logging("warning")
    handlers = [h for h in logging.getLogger().handlers if h.get_name() == "tessa-json"]
    assert len(handlers) == 1
    assert logging.getLogger().level == logging.WARNING


async def test_access_log_has_no_query_string(
    client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="tessa_api.request")
    await client.get("/health?ticket=very-secret-ticket")
    records = [r for r in caplog.records if r.name == "tessa_api.request"]
    assert records
    assert records[-1].__dict__["path"] == "/health"
    assert "very-secret-ticket" not in caplog.text
