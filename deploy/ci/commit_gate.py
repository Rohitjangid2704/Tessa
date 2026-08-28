#!/usr/bin/env python3
import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, NoReturn

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_UNCERTAIN = 2
EXIT_ERROR = 3

API_URL_ENV = "TESSA_API_URL"
SERVICE_KEY_ENV = "TESSA_SERVICE_KEY"
SCHEDULE_ID_ENV = "TESSA_SCHEDULE_ID"
REPORT_BASE_URL_ENV = "TESSA_REPORT_BASE_URL"
REVISION_ENVS = ("TESSA_GATE_REVISION", "GITHUB_SHA", "CI_COMMIT_SHA")

SERVICE_KEY_HEADER = "X-Service-Key"
IDEMPOTENCY_HEADER = "Idempotency-Key"
IDEMPOTENCY_KEY_MAX_LENGTH = 128
RUN_NOW_PATH = "/api/v1/schedules/{schedule_id}/run-now"
RUN_PATH = "/api/v1/runs/{run_id}"

TERMINAL_STATUSES = frozenset({"completed", "failed", "canceled", "budget_exceeded"})
RETRYABLE_HTTP_STATUSES = frozenset({408, 429, 502, 503, 504})
REQUEST_TIMEOUT_SECONDS = 20.0
REQUEST_ATTEMPTS = 4
RETRY_DELAY_SECONDS = 2.0
CONSECUTIVE_POLL_FAILURES_ALLOWED = 5
DEFAULT_MAX_MINUTES = 15.0
MAX_MINUTES_CEILING = 240.0
DEFAULT_POLL_SECONDS = 5.0
POLL_SECONDS_FLOOR = 1.0
POLL_SECONDS_CEILING = 60.0
ERROR_TEXT_LIMIT = 300


class GateError(Exception):
    pass


class GateArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(EXIT_ERROR, f"{self.prog}: error: {message}\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        return None


@dataclass(frozen=True, slots=True)
class GateConfig:
    api_url: str
    service_key: str
    schedule_id: uuid.UUID
    idempotency_key: str
    max_seconds: float
    poll_seconds: float
    report_base_url: str | None


@dataclass(frozen=True, slots=True)
class RunState:
    run_id: str
    status: str
    passed: int
    failed: int
    flaky: int
    uncertain: int
    skipped: int

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    def describe(self) -> str:
        return (
            f"{self.status}: pass {self.passed} fail {self.failed} flaky {self.flaky} "
            f"uncertain {self.uncertain} skipped {self.skipped}"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = GateArgumentParser(
        description="Run the commit tier schedule of a Tessa target and gate on its verdict",
        epilog=(
            f"Reads {API_URL_ENV}, {SERVICE_KEY_ENV} (environment only), {SCHEDULE_ID_ENV} and "
            f"{REPORT_BASE_URL_ENV}. Exit codes: 0 pass, 1 fail, 2 uncertain, 3 usage, timeout "
            "or transport error."
        ),
    )
    parser.add_argument("--api-url", help=f"base URL of the Tessa API (or {API_URL_ENV})")
    parser.add_argument("--schedule-id", help=f"commit tier schedule id (or {SCHEDULE_ID_ENV})")
    parser.add_argument(
        "--max-minutes",
        type=float,
        default=DEFAULT_MAX_MINUTES,
        help="hard limit for the whole gate in minutes, start of the run included",
    )
    parser.add_argument(
        "--poll-seconds", type=float, default=DEFAULT_POLL_SECONDS, help="seconds between polls"
    )
    parser.add_argument(
        "--revision",
        help="commit id that keys the Idempotency-Key, so a re-run of the same commit reuses "
        "the run (or GITHUB_SHA, CI_COMMIT_SHA)",
    )
    parser.add_argument("--idempotency-key", help="explicit Idempotency-Key, overrides --revision")
    parser.add_argument(
        "--report-base-url",
        help=f"base URL of the Tessa web app for the report link (or {REPORT_BASE_URL_ENV})",
    )
    return parser


def first_present(*values: str | None) -> str | None:
    return next((value.strip() for value in values if value and value.strip()), None)


def parse_api_url(raw: str | None) -> str:
    if raw is None:
        raise GateError(f"the API address is missing: pass --api-url or set {API_URL_ENV}")
    cleaned = raw.rstrip("/")
    if not re.match(r"^https?://[^/\s]+(/\S*)?$", cleaned):
        raise GateError("the API address must be an http or https URL")
    return cleaned


def parse_service_key(raw: str | None) -> str:
    key = first_present(raw)
    if key is None:
        raise GateError(f"the service key is missing: set {SERVICE_KEY_ENV}")
    if not (key.isascii() and key.isprintable()):
        raise GateError(f"{SERVICE_KEY_ENV} holds characters that cannot be sent in a header")
    return key


def parse_schedule_id(raw: str | None) -> uuid.UUID:
    if raw is None:
        raise GateError(f"the schedule id is missing: pass --schedule-id or set {SCHEDULE_ID_ENV}")
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise GateError("the schedule id is not a UUID") from None


def parse_bounded(value: float, name: str, low: float, high: float) -> float:
    if not low <= value <= high:
        raise GateError(f"{name} must be between {low:g} and {high:g}")
    return value


def idempotency_key_of(explicit: str | None, schedule_id: uuid.UUID, revision: str | None) -> str:
    if explicit is not None:
        key = explicit
    else:
        suffix = revision or uuid.uuid4().hex
        key = f"commit-gate-{schedule_id}-{suffix}"
    printable = re.sub(r"[^\x21-\x7E]", "-", key)[:IDEMPOTENCY_KEY_MAX_LENGTH]
    if len(printable) < 8:
        raise GateError("the idempotency key needs 8 to 128 printable characters")
    return printable


def parse_config(argv: Sequence[str] | None, environ: Mapping[str, str]) -> GateConfig:
    arguments = build_parser().parse_args(argv)
    service_key = parse_service_key(environ.get(SERVICE_KEY_ENV))
    schedule_id = parse_schedule_id(
        first_present(arguments.schedule_id, environ.get(SCHEDULE_ID_ENV))
    )
    revision = first_present(arguments.revision, *(environ.get(name) for name in REVISION_ENVS))
    report_base_url = first_present(arguments.report_base_url, environ.get(REPORT_BASE_URL_ENV))
    max_minutes = parse_bounded(arguments.max_minutes, "--max-minutes", 0.5, MAX_MINUTES_CEILING)
    return GateConfig(
        api_url=parse_api_url(first_present(arguments.api_url, environ.get(API_URL_ENV))),
        service_key=service_key,
        schedule_id=schedule_id,
        idempotency_key=idempotency_key_of(arguments.idempotency_key, schedule_id, revision),
        max_seconds=max_minutes * 60,
        poll_seconds=parse_bounded(
            arguments.poll_seconds, "--poll-seconds", POLL_SECONDS_FLOOR, POLL_SECONDS_CEILING
        ),
        report_base_url=None if report_base_url is None else report_base_url.rstrip("/"),
    )


class ApiClient:
    def __init__(self, config: GateConfig) -> None:
        self.config = config
        self.opener = urllib.request.build_opener(NoRedirect)

    def redact(self, text: str) -> str:
        return text.replace(self.config.service_key, "***")

    def describe_http_error(self, method: str, path: str, status: int, body: bytes) -> str:
        detail = ""
        try:
            error = json.loads(body).get("error", {})
            detail = f"{error.get('code', '')}: {error.get('message', '')}".strip(": ")
        except (ValueError, AttributeError):
            detail = body[:ERROR_TEXT_LIMIT].decode("utf-8", errors="replace").strip()
        text = f"{method} {path} answered HTTP {status}"
        return self.redact(f"{text} ({detail[:ERROR_TEXT_LIMIT]})" if detail else text)

    def once(self, method: str, path: str, extra_headers: Mapping[str, str]) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.config.api_url}{path}",
            data=b"" if method == "POST" else None,
            method=method,
            headers={
                SERVICE_KEY_HEADER: self.config.service_key,
                "Accept": "application/json",
                **extra_headers,
            },
        )
        with self.opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read())
        if not isinstance(payload, dict):
            raise GateError(f"{method} {path} did not answer with a JSON object")
        return payload

    def send(
        self, method: str, path: str, extra_headers: Mapping[str, str], deadline: float
    ) -> dict[str, Any]:
        last_problem = "no answer"
        for attempt in range(1, REQUEST_ATTEMPTS + 1):
            try:
                return self.once(method, path, extra_headers)
            except urllib.error.HTTPError as error:
                if error.code not in RETRYABLE_HTTP_STATUSES:
                    raise GateError(
                        self.describe_http_error(method, path, error.code, error.read())
                    ) from None
                last_problem = f"HTTP {error.code}"
            except (OSError, http.client.HTTPException) as error:
                last_problem = type(error).__name__
            except ValueError:
                last_problem = "an answer that is not JSON"
            if attempt == REQUEST_ATTEMPTS or time.monotonic() + RETRY_DELAY_SECONDS >= deadline:
                break
            time.sleep(RETRY_DELAY_SECONDS)
        raise GateError(f"{method} {path} failed: {last_problem}")


def run_state_of(payload: Mapping[str, Any]) -> RunState:
    counters = payload.get("counters")
    status = payload.get("status")
    run_id = payload.get("id")
    if not isinstance(counters, dict) or not isinstance(status, str) or not isinstance(run_id, str):
        raise GateError("the run answer has no status or counters")
    return RunState(
        run_id=run_id,
        status=status,
        passed=int(counters.get("pass", 0)),
        failed=int(counters.get("fail", 0)),
        flaky=int(counters.get("flaky", 0)),
        uncertain=int(counters.get("uncertain", 0)),
        skipped=int(counters.get("skipped", 0)),
    )


def exit_code_of(state: RunState) -> int:
    if state.failed > 0 or state.flaky > 0 or state.status == "failed":
        return EXIT_FAIL
    if state.status == "canceled":
        return EXIT_ERROR
    if state.status == "budget_exceeded" or state.uncertain > 0 or state.passed == 0:
        return EXIT_UNCERTAIN
    return EXIT_PASS


def outcome_name(code: int) -> str:
    return {
        EXIT_PASS: "pass",
        EXIT_FAIL: "fail",
        EXIT_UNCERTAIN: "uncertain",
        EXIT_ERROR: "no verdict (the run was canceled)",
    }[code]


def report_link(config: GateConfig, run_id: str) -> str:
    base = config.report_base_url or config.api_url
    suffix = f"/runs/{run_id}" if config.report_base_url else RUN_PATH.format(run_id=run_id)
    return f"{base}{suffix}"


def start_run(client: ApiClient, deadline: float) -> str:
    config = client.config
    payload = client.send(
        "POST",
        RUN_NOW_PATH.format(schedule_id=config.schedule_id),
        {IDEMPOTENCY_HEADER: config.idempotency_key},
        deadline,
    )
    try:
        return str(uuid.UUID(str(payload["run_id"])))
    except (KeyError, ValueError):
        raise GateError("run-now did not answer with a run id") from None


def poll_until_terminal(client: ApiClient, run_id: str, deadline: float) -> RunState:
    path = RUN_PATH.format(run_id=run_id)
    failures = 0
    shown = ""
    while True:
        try:
            state = run_state_of(client.send("GET", path, {}, deadline))
            failures = 0
        except GateError as error:
            failures += 1
            if failures >= CONSECUTIVE_POLL_FAILURES_ALLOWED:
                raise GateError(f"polling the run failed {failures} times: {error}") from None
        else:
            description = state.describe()
            if description != shown:
                print(f"commit gate: {description}", flush=True)
                shown = description
            if state.is_terminal:
                return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GateError(f"timed out before run {run_id} finished")
        time.sleep(min(client.config.poll_seconds, remaining))


def run_gate(config: GateConfig) -> int:
    deadline = time.monotonic() + config.max_seconds
    client = ApiClient(config)
    run_id = start_run(client, deadline)
    print(f"commit gate: run {run_id} started for schedule {config.schedule_id}", flush=True)
    print(f"commit gate: report {report_link(config, run_id)}", flush=True)
    state = poll_until_terminal(client, run_id, deadline)
    code = exit_code_of(state)
    print(f"commit gate: result {outcome_name(code)} ({state.describe()})", flush=True)
    return code


def main(argv: Sequence[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    try:
        config = parse_config(argv, os.environ if environ is None else environ)
        return run_gate(config)
    except GateError as error:
        print(f"commit gate: {error}", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        print("commit gate: interrupted", file=sys.stderr, flush=True)
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
