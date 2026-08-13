from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.scenario import (
    BrowserExpect,
    GraphqlExpect,
    HttpExpect,
    SseExpect,
    WebsocketExpect,
)
from tessa_api.schemas.steps import Tier0Failure, Tier0Result
from tessa_worker.adapters.base import StepRecord
from tessa_worker.checks.chat_checks import sse_failures
from tessa_worker.checks.common import Tier0MismatchError
from tessa_worker.checks.contracts import StepExpectations, Tier0Context
from tessa_worker.checks.graphql_checks import graphql_failures
from tessa_worker.checks.http_checks import http_failures
from tessa_worker.checks.page_checks import browser_failures
from tessa_worker.checks.websocket_checks import websocket_failures


def expectation_failures(
    step_record: StepRecord, expectations: StepExpectations, context: Tier0Context
) -> list[Tier0Failure]:
    if isinstance(expectations, HttpExpect) and step_record.adapter is AdapterKind.http:
        return http_failures(step_record, expectations, context)
    if isinstance(expectations, SseExpect) and step_record.adapter is AdapterKind.sse:
        return sse_failures(step_record, expectations, context)
    if isinstance(expectations, BrowserExpect) and step_record.adapter is AdapterKind.browser:
        return browser_failures(step_record, expectations)
    if isinstance(expectations, WebsocketExpect) and step_record.adapter is AdapterKind.websocket:
        return websocket_failures(step_record, expectations, context)
    if isinstance(expectations, GraphqlExpect) and step_record.adapter is AdapterKind.graphql:
        return graphql_failures(step_record, expectations, context)
    raise Tier0MismatchError(
        f"{type(expectations).__name__} cannot be evaluated on a {step_record.adapter.value} step"
    )


def evaluate_tier0(
    step_record: StepRecord,
    expectations: StepExpectations,
    context: Tier0Context,
    /,
) -> Tier0Result:
    failures = expectation_failures(step_record, expectations, context)
    return Tier0Result(passed=not failures, failures=failures)
