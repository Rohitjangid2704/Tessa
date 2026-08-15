import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import StepRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.steps import HttpStepRequest, HttpStepResponse, Tier0Result
from tessa_api.schemas.streams import IngestEvent, StepRecordedPayload
from tessa_api.services.grading_rules import MachineGrading, clip_text
from tessa_api.services.step_overlay import StepStanding, step_graded_event
from tessa_worker.adapters.redact import Redactor
from tessa_worker.event_client import build_event
from tessa_worker.fuzz.checks import stable_message, tier0_failure_of
from tessa_worker.fuzz.models import CollectedFailure, FuzzOutcome
from tessa_worker.fuzz.redaction import safe_headers, safe_json_body, safe_request_body
from tessa_worker.verdicts import TIER0_FAILED, fail_verdict, pass_verdict

ATTEMPT = 0
MAX_FAILURE_STEPS = 50
LABEL_LIMIT = 200
SUMMARY_METHOD = "FUZZ"
STEP_RECORDED_EVENT = "step.recorded"
GRADED_TOKEN = "api_fuzz"


@dataclass(frozen=True, slots=True)
class StepContext:
    run_id: uuid.UUID
    run_scenario_id: uuid.UUID
    redactor: Redactor
    payload_limit_bytes: int
    target_url: str


def request_model(
    failure: CollectedFailure, seed: int, context: StepContext
) -> tuple[dict[str, Any], bool]:
    request = failure.request
    redactor = context.redactor
    body, body_cut = safe_request_body(
        None if request is None else request.body, redactor, context.payload_limit_bytes
    )
    payload: dict[str, Any] = {
        "kind": "http",
        "method": "GET" if request is None else request.method,
        "url": redactor.redact_text("" if request is None else request.url),
        "headers": {} if request is None else safe_headers(request.headers, redactor),
        "query": None,
        "body": body,
        "fuzz": {
            "check": failure.check,
            "title": clip_text(failure.title, LABEL_LIMIT),
            "operation": failure.operation,
            "seed": seed,
        },
    }
    return HttpStepRequest.model_validate(payload).model_dump(mode="json"), body_cut


def response_model(failure: CollectedFailure, context: StepContext) -> tuple[dict[str, Any], bool]:
    response = failure.response
    if response is None:
        return {}, False
    body, text_body, cut = safe_json_body(
        response.content, response.headers, context.redactor, context.payload_limit_bytes
    )
    payload: dict[str, Any] = {
        "kind": "http",
        "status": response.status_code,
        "headers": safe_headers(response.headers, context.redactor),
        "body": body,
        "body_text": text_body,
    }
    return HttpStepResponse.model_validate(payload).model_dump(
        mode="json"
    ), cut or response.truncated


def failure_row(
    index: int, failure: CollectedFailure, seed: int, context: StepContext, now: datetime
) -> StepRow:
    request, request_cut = request_model(failure, seed, context)
    response, response_cut = response_model(failure, context)
    tier0 = Tier0Result(passed=False, failures=[tier0_failure_of(failure, context.redactor)])
    verdict = fail_verdict(stable_message(failure), TIER0_FAILED)
    grading = MachineGrading(verdict=verdict, escalated_to=None, review_reasons=[])
    return StepRow(
        id=new_id(),
        run_scenario_id=context.run_scenario_id,
        run_id=context.run_id,
        attempt=ATTEMPT,
        index=index,
        adapter=AdapterKind.http,
        label=clip_text(f"{failure.operation}: {failure.check}", LABEL_LIMIT),
        request=request,
        response=response or None,
        response_truncated=request_cut or response_cut,
        tier0=tier0.model_dump(mode="json"),
        latency_ms=0 if failure.response is None else failure.response.elapsed_ms,
        verdict=verdict.model_dump(mode="json"),
        machine_grading=grading.model_dump(mode="json"),
        ok=failure.response is not None,
        tier0_failure_count=1,
        started_at=now,
        finished_at=now,
    )


def summary_row(outcome: FuzzOutcome, context: StepContext, now: datetime) -> StepRow:
    payload: dict[str, Any] = {
        "kind": "http",
        "method": SUMMARY_METHOD,
        "url": context.redactor.redact_text(context.target_url),
        "headers": {},
        "query": None,
        "body": None,
        "fuzz": {
            "seed": outcome.seed,
            "cases": outcome.cases_run,
            "operations": outcome.operations,
            "stop": outcome.stop.value,
        },
    }
    verdict = pass_verdict()
    grading = MachineGrading(verdict=verdict, escalated_to=None, review_reasons=[])
    return StepRow(
        id=new_id(),
        run_scenario_id=context.run_scenario_id,
        run_id=context.run_id,
        attempt=ATTEMPT,
        index=0,
        adapter=AdapterKind.http,
        label=clip_text(
            f"API fuzz: {outcome.cases_run} cases over {outcome.operations} operations "
            f"(seed {outcome.seed})",
            LABEL_LIMIT,
        ),
        request=HttpStepRequest.model_validate(payload).model_dump(mode="json"),
        response=None,
        response_truncated=False,
        tier0=Tier0Result(passed=True, failures=[]).model_dump(mode="json"),
        latency_ms=outcome.elapsed_ms,
        verdict=verdict.model_dump(mode="json"),
        machine_grading=grading.model_dump(mode="json"),
        ok=True,
        tier0_failure_count=0,
        started_at=now,
        finished_at=now,
    )


def recorded_event(row: StepRow) -> IngestEvent:
    return build_event(
        row.run_id,
        STEP_RECORDED_EVENT,
        StepRecordedPayload(
            step_id=row.id,
            run_scenario_id=row.run_scenario_id,
            attempt=row.attempt,
            index=row.index,
            adapter=row.adapter,
            label=row.label,
            ok=row.ok,
            latency_ms=row.latency_ms,
            cost_usd=0.0,
            tier0_failure_count=row.tier0_failure_count,
            screenshot_count=0,
        ),
        f"{STEP_RECORDED_EVENT}:{row.run_scenario_id}:{row.attempt}:{row.index}",
    )


def step_events(rows: list[StepRow]) -> list[IngestEvent]:
    events: list[IngestEvent] = []
    for row in rows:
        events.append(recorded_event(row))
        if row.verdict is not None:
            standing = StepStanding(Verdict.model_validate(row.verdict), None)
            graded = step_graded_event(row, standing, GRADED_TOKEN)
            if graded is not None:
                events.append(graded)
    return events


async def store_steps(
    session_factory: SessionFactory,
    context: StepContext,
    outcome: FuzzOutcome,
) -> tuple[list[IngestEvent], int]:
    now = datetime.now(UTC)
    recorded = outcome.failures[:MAX_FAILURE_STEPS]
    rows = [
        summary_row(outcome, context, now),
        *(
            failure_row(index, failure, outcome.seed, context, now)
            for index, failure in enumerate(recorded, start=1)
        ),
    ]
    async with session_factory() as session:
        await clear_attempt(session, context)
        session.add_all(rows)
        await session.commit()
    return step_events(rows), len(outcome.failures) - len(recorded)


async def clear_attempt(session: AsyncSession, context: StepContext) -> None:
    await session.execute(
        delete(StepRow).where(
            StepRow.run_scenario_id == context.run_scenario_id, StepRow.attempt == ATTEMPT
        )
    )
