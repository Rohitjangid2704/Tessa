import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from pydantic import JsonValue

from tessa_api.schemas.enums import AdapterKind, SkipReason
from tessa_api.schemas.scenario import GraphqlStep, ScenarioStep
from tessa_api.schemas.steps import GraphqlError, GraphqlStepRequest, GraphqlStepResponse
from tessa_worker.adapters.base import Adapter, AdapterCapabilities, StepRecord
from tessa_worker.adapters.context import AdapterContext
from tessa_worker.adapters.errors import StepRefusedError
from tessa_worker.adapters.graphql_document import (
    INTROSPECTION_QUERY,
    Operation,
    OperationError,
    OperationKind,
    SchemaCheck,
    SchemaCheckStatus,
    SchemaState,
    analyze_document,
    check_against_schema,
    schema_from_introspection,
)
from tessa_worker.adapters.http_core import elapsed_ms
from tessa_worker.adapters.net_core import (
    JSON_CONTENT_TYPE,
    HttpSender,
    NetworkAdapter,
    Received,
    compact_json,
    failure_message,
    identity_headers,
    parse_json_body,
    request_headers,
)
from tessa_worker.adapters.payload import fit_items, json_size, json_text
from tessa_worker.adapters.step_payloads import step_record

GRAPHQL_CAPABILITIES = AdapterCapabilities()
INTROSPECTION_MAX_BYTES = 4 * 1024 * 1024
MUTATION_REFUSAL = "GraphQL mutations are refused on read-only runs, which production targets use"
SUBSCRIPTION_REFUSAL = "GraphQL subscriptions are not supported by this adapter"


@dataclass
class Dispatch:
    url: str
    query: str
    operation_name: str | None
    variables: dict[str, JsonValue]
    label: str
    check: SchemaCheck | None = None

    def payload(self) -> dict[str, JsonValue]:
        body: dict[str, JsonValue] = {"query": self.query}
        if self.operation_name is not None:
            body["operationName"] = self.operation_name
        if self.variables:
            body["variables"] = self.variables
        return body


class GraphqlAdapter(NetworkAdapter):
    kind = AdapterKind.graphql

    def __init__(
        self, context: AdapterContext, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        super().__init__(context, transport)
        self.sender = HttpSender(context, transport)
        self._schemas: dict[str | None, SchemaState] = {}

    async def drive(self, step: ScenarioStep) -> StepRecord:
        if not isinstance(step, GraphqlStep):
            raise TypeError(f"the graphql adapter cannot drive a {step.adapter} step")
        started_at = datetime.now(UTC)
        clock = time.perf_counter()
        dispatch = Dispatch(
            url=self.context.interface.base_url,
            query=step.query,
            operation_name=step.operation_name,
            variables=step.variables,
            label=step.operation_name or "operation",
        )
        received: Received | None = None
        failure: str | None = None
        try:
            received = await self.execute(step, dispatch)
        except StepRefusedError:
            raise
        except Exception as error:
            failure = failure_message(error, self.timeout_seconds)
            if failure is None:
                raise
        latency_ms = received.latency_ms if received is not None else elapsed_ms(clock)
        return self.record(step, dispatch, received, failure, latency_ms, started_at)

    async def execute(self, step: GraphqlStep, dispatch: Dispatch) -> Received:
        environment = self.context.environment
        dispatch.query = environment.substitute(step.query)
        variables = environment.substitute_json(step.variables)
        dispatch.variables = variables if isinstance(variables, dict) else {}
        operation = self.operation(step, dispatch)
        identity = await self.identities.identity(step.as_)
        headers = request_headers(JSON_CONTENT_TYPE, True, identity_headers(identity), {})
        dispatch.check = await self.schema_check(step, operation, headers, dispatch.url)
        return await self.sender.send(
            "POST",
            dispatch.url,
            headers,
            compact_json(dispatch.payload()),
            self.guard.read_budget(),
        )

    def operation(self, step: GraphqlStep, dispatch: Dispatch) -> Operation | None:
        try:
            operation = analyze_document(dispatch.query, step.operation_name)
        except OperationError:
            if step.expect.no_errors:
                raise
            return None
        if operation.name is not None:
            dispatch.label = operation.name
        if operation.kind is OperationKind.subscription:
            raise OperationError(SUBSCRIPTION_REFUSAL)
        if operation.kind is OperationKind.mutation and self.context.scope.read_only:
            raise StepRefusedError(MUTATION_REFUSAL, SkipReason.production_blocked)
        return operation

    async def schema_check(
        self,
        step: GraphqlStep,
        operation: Operation | None,
        headers: dict[str, str],
        url: str,
    ) -> SchemaCheck | None:
        if operation is None:
            return None
        state = self._schemas.get(step.as_)
        if state is None:
            state = await self.fetch_schema(url, headers)
            self._schemas[step.as_] = state
        check = check_against_schema(state, operation)
        if check.status is SchemaCheckStatus.invalid and step.expect.no_errors:
            raise OperationError(check.message or "the operation does not match the schema")
        return check

    async def fetch_schema(self, url: str, headers: dict[str, str]) -> SchemaState:
        try:
            received = await self.sender.send(
                "POST",
                url,
                headers,
                compact_json({"query": INTROSPECTION_QUERY}),
                INTROSPECTION_MAX_BYTES,
            )
        except Exception as error:
            message = failure_message(error, self.timeout_seconds)
            if message is None:
                raise
            return SchemaState(None, f"the introspection request failed: {message}")
        parsed = parse_json_body(received.raw, received.cut)
        data = parsed.get("data") if isinstance(parsed, dict) else None
        if data is None:
            return SchemaState(
                None,
                f"the endpoint answered HTTP {received.status} without an introspection "
                "result, introspection may be disabled",
            )
        return schema_from_introspection(data)

    def record(
        self,
        step: GraphqlStep,
        dispatch: Dispatch,
        received: Received | None,
        failure: str | None,
        latency_ms: int,
        started_at: datetime,
    ) -> StepRecord:
        guard = self.guard
        query = guard.text(dispatch.query)
        variables = guard.json(dispatch.variables) if dispatch.variables else None
        variables_cut = variables is not None and variables.truncated
        payload: dict[str, JsonValue] = {
            "kind": "graphql",
            "url": guard.url(dispatch.url),
            "operation_name": dispatch.operation_name,
            "query": query.text,
            "variables": None if variables is None or variables.truncated else variables.value,
        }
        if dispatch.check is not None:
            payload["schema_check"] = self.guard.redactor.redact_json(dispatch.check.as_json())
        request = GraphqlStepRequest.model_validate(payload)
        described = None if received is None else self.describe(received)
        response = None if described is None else described[0]
        truncated = query.truncated or variables_cut or (described is not None and described[1])
        return step_record(
            AdapterKind.graphql,
            guard,
            step.label or f"GraphQL {dispatch.label}",
            request,
            response,
            failure is None,
            failure,
            truncated,
            latency_ms,
            started_at,
        )

    def describe(self, received: Received) -> tuple[GraphqlStepResponse, bool]:
        guard = self.guard
        parsed = parse_json_body(received.raw, received.cut)
        payload: dict[str, JsonValue]
        if isinstance(parsed, dict):
            data = guard.json(parsed.get("data"))
            errors, errors_cut = self.describe_errors(parsed.get("errors"))
            payload = {
                "kind": "graphql",
                "status": received.status,
                "data": data.value,
                "errors": [error.model_dump(mode="json") for error in errors],
            }
            if data.truncated:
                payload["data_text"] = data.text
            return GraphqlStepResponse.model_validate(payload), data.truncated or errors_cut
        text = guard.raw_text(received.raw, received.cut) if received.raw else None
        payload = {
            "kind": "graphql",
            "status": received.status,
            "data": None,
            "errors": [],
            "body_text": None if text is None else text.text,
        }
        truncated = received.cut or (text is not None and text.truncated)
        return GraphqlStepResponse.model_validate(payload), truncated

    def describe_errors(self, raw: JsonValue) -> tuple[list[GraphqlError], bool]:
        if not isinstance(raw, list):
            return [], False
        errors = [self.describe_error(item) for item in raw if isinstance(item, dict)]
        return fit_items(
            errors, lambda error: json_size(error.model_dump(mode="json")), self.guard.cap
        )

    def describe_error(self, item: dict[str, JsonValue]) -> GraphqlError:
        redactor = self.guard.redactor
        message = item.get("message")
        path = item.get("path")
        extensions = item.get("extensions")
        if isinstance(message, str):
            text = message
        else:
            text = "" if message is None else json_text(message)
        return GraphqlError(
            message=redactor.redact_text(text),
            path=[redactor.redact_text(str(part)) for part in path]
            if isinstance(path, list)
            else None,
            extensions=redactor.redact_object(extensions) if isinstance(extensions, dict) else None,
        )

    async def close(self) -> None:
        await self.sender.close()
        await super().close()


async def open_graphql_adapter(context: AdapterContext) -> Adapter:
    return GraphqlAdapter(context)
