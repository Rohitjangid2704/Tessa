from dataclasses import dataclass
from enum import StrEnum
from typing import cast

from graphql import (
    DocumentNode,
    GraphQLError,
    GraphQLSchema,
    IntrospectionQuery,
    OperationDefinitionNode,
    build_client_schema,
    get_introspection_query,
    parse,
    validate,
)
from pydantic import JsonValue

from tessa_worker.adapters.errors import AdapterError

INTROSPECTION_QUERY = get_introspection_query(descriptions=False)
MAX_REPORTED_PROBLEMS = 5


class OperationKind(StrEnum):
    query = "query"
    mutation = "mutation"
    subscription = "subscription"


class SchemaCheckStatus(StrEnum):
    validated = "validated"
    uncertain = "uncertain"
    invalid = "invalid"


class OperationError(AdapterError):
    pass


@dataclass(frozen=True)
class Operation:
    name: str | None
    kind: OperationKind
    document: DocumentNode


@dataclass(frozen=True)
class SchemaState:
    schema: GraphQLSchema | None
    reason: str | None


@dataclass(frozen=True)
class SchemaCheck:
    status: SchemaCheckStatus
    message: str | None
    problems: tuple[str, ...] = ()

    def as_json(self) -> dict[str, JsonValue]:
        shown: list[JsonValue] = list(self.problems)
        return {"status": self.status.value, "message": self.message, "problems": shown}


def analyze_document(query: str, operation_name: str | None) -> Operation:
    try:
        document = parse(query, no_location=True)
    except GraphQLError as error:
        raise OperationError(f"the GraphQL document does not parse: {error.message}") from None
    operations = [
        definition
        for definition in document.definitions
        if isinstance(definition, OperationDefinitionNode)
    ]
    if not operations:
        raise OperationError("the GraphQL document defines no operation")
    chosen = choose_operation(operations, operation_name)
    return Operation(
        name=chosen.name.value if chosen.name is not None else None,
        kind=OperationKind(chosen.operation.value),
        document=document,
    )


def choose_operation(
    operations: list[OperationDefinitionNode], operation_name: str | None
) -> OperationDefinitionNode:
    if operation_name is None:
        if len(operations) > 1:
            raise OperationError(
                f"the GraphQL document defines {len(operations)} operations, set operation_name"
            )
        return operations[0]
    for operation in operations:
        if operation.name is not None and operation.name.value == operation_name:
            return operation
    raise OperationError(f"the GraphQL document defines no operation named {operation_name}")


def schema_from_introspection(data: JsonValue) -> SchemaState:
    if not isinstance(data, dict) or "__schema" not in data:
        return SchemaState(None, "the endpoint answered without an introspection schema")
    try:
        return SchemaState(build_client_schema(cast(IntrospectionQuery, data)), None)
    except (GraphQLError, TypeError, ValueError, KeyError):
        return SchemaState(None, "the introspection result could not be read as a GraphQL schema")


def check_against_schema(state: SchemaState, operation: Operation) -> SchemaCheck:
    if state.schema is None:
        reason = state.reason or "the schema is unavailable"
        return SchemaCheck(
            SchemaCheckStatus.uncertain, f"the operation was not checked against a schema: {reason}"
        )
    problems = tuple(error.message for error in validate(state.schema, operation.document))
    if not problems:
        return SchemaCheck(SchemaCheckStatus.validated, None)
    shown = problems[:MAX_REPORTED_PROBLEMS]
    return SchemaCheck(
        SchemaCheckStatus.invalid,
        f"the operation does not match the schema: {'; '.join(shown)}",
        shown,
    )
