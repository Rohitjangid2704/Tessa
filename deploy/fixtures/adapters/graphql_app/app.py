import os
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from graphql import graphql
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from fixtures.adapters.graphql_app.config import (
    DEFAULT_STAFF_TOKEN,
    DEFAULT_VIEWER_TOKEN,
    MAX_QUERY_CHARS,
    STAFF_ROLE,
    STAFF_TOKEN_ENV,
    VIEWER_ROLE,
    VIEWER_TOKEN_ENV,
)
from fixtures.adapters.graphql_app.schema import (
    RequestContext,
    build_fixture_schema,
    build_root_value,
)
from fixtures.adapters.graphql_app.store import Dataset

BAD_REQUEST = 400
UNAUTHENTICATED = 401


class GraphqlRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    operation_name: str | None = Field(default=None, alias="operationName")
    variables: dict[str, Any] | None = None


def error_response(status: int, message: str, code: str) -> JSONResponse:
    return JSONResponse(
        {"errors": [{"message": message, "extensions": {"code": code}}]}, status_code=status
    )


def role_of(request: Request, roles_by_token: dict[str, str]) -> str | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        return None
    return roles_by_token.get(value.strip())


async def parse_request(request: Request) -> GraphqlRequest | None:
    try:
        body = await request.json()
        return GraphqlRequest.model_validate(body)
    except (ValueError, ValidationError):
        return None


def create_app(dataset: Dataset | None = None) -> FastAPI:
    data = dataset or Dataset()
    schema = build_fixture_schema()
    root_value = build_root_value(data)
    roles_by_token = {
        os.environ.get(STAFF_TOKEN_ENV, DEFAULT_STAFF_TOKEN): STAFF_ROLE,
        os.environ.get(VIEWER_TOKEN_ENV, DEFAULT_VIEWER_TOKEN): VIEWER_ROLE,
    }
    app = FastAPI(title="Tessa GraphQL fixture", docs_url=None, redoc_url=None)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/qa/reset")
    async def reset() -> dict[str, str]:
        data.reset()
        return {"hash": data.state_hash()}

    @app.get("/qa/hash")
    async def state_hash() -> dict[str, str]:
        return {"hash": data.state_hash()}

    @app.post("/graphql")
    async def execute(request: Request) -> JSONResponse:
        role = role_of(request, roles_by_token)
        if role is None:
            return error_response(UNAUTHENTICATED, "unauthenticated", "UNAUTHENTICATED")
        operation = await parse_request(request)
        if operation is None:
            return error_response(
                BAD_REQUEST,
                "the body must be a JSON object with a query string, an optional operationName "
                "and optional variables",
                "BAD_REQUEST",
            )
        result = await graphql(
            schema,
            operation.query,
            root_value=root_value,
            context_value=RequestContext(role=role),
            variable_values=operation.variables,
            operation_name=operation.operation_name,
        )
        return JSONResponse(result.formatted)

    return app
