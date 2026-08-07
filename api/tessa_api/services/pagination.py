import base64
import binascii
import json
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import Depends, Query, Request
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from sqlalchemy import ColumnElement, Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import QueryableAttribute

from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
MAX_CURSOR_LENGTH = 2048
ID_KEY = "id"

CURSOR_SORT_FIELD = "sort"
CURSOR_VALUES_FIELD = "values"


@dataclass(frozen=True)
class SortTerm:
    key: str
    descending: bool

    def render(self) -> str:
        return f"-{self.key}" if self.descending else self.key


@dataclass(frozen=True)
class PageQuery:
    limit: int
    cursor: str | None
    include_total: bool
    sort: tuple[SortTerm, ...]

    @property
    def sort_text(self) -> str:
        return ",".join(term.render() for term in self.sort)


@dataclass(frozen=True)
class SortableColumn:
    expression: ColumnElement[Any]
    value_type: type


@dataclass(frozen=True)
class PageResult[T]:
    rows: list[T]
    next_cursor: str | None
    total: int | None


def sortable(
    column: ColumnElement[Any] | QueryableAttribute[Any], value_type: type | None = None
) -> SortableColumn:
    expression = column.expression
    return SortableColumn(expression, value_type or expression.type.python_type)


def unknown_parameter_error(name: str, code: str, message: str) -> ApiError:
    detail = ErrorDetail(loc=["query", name], code=code, message=message)
    return ApiError(422, "validation_failed", "Request validation failed", [detail])


def declared_query_names(dependant: Dependant) -> set[str]:
    names = {str(getattr(field, "alias", None) or field.name) for field in dependant.query_params}
    for child in dependant.dependencies:
        names |= declared_query_names(child)
    return names


async def reject_unknown_query_parameters(request: Request) -> None:
    route = request.scope.get("route")
    if not isinstance(route, APIRoute):
        return
    declared = declared_query_names(route.dependant)
    unknown = sorted(set(request.query_params.keys()) - declared)
    if unknown:
        details = [
            ErrorDetail(
                loc=["query", name],
                code="unknown_query_parameter",
                message=f"Unknown query parameter {name!r}",
            )
            for name in unknown
        ]
        raise ApiError(422, "validation_failed", "Request validation failed", details)


UnknownQueryRejected = Depends(reject_unknown_query_parameters)


def parse_sort(raw: str, allowed: Sequence[str]) -> tuple[SortTerm, ...]:
    terms: list[SortTerm] = []
    for part in raw.split(","):
        text = part.strip()
        descending = text.startswith("-")
        key = text.removeprefix("-")
        if not key:
            raise unknown_parameter_error("sort", "invalid_sort", "Empty sort key")
        if key not in allowed:
            raise unknown_parameter_error(
                "sort",
                "unknown_sort_key",
                f"Unknown sort key {key!r}; allowed: {', '.join(allowed)}",
            )
        if any(term.key == key for term in terms):
            raise unknown_parameter_error(
                "sort", "duplicate_sort_key", f"Duplicate sort key {key!r}"
            )
        terms.append(SortTerm(key, descending))
    return tuple(terms)


def page_query(allowed_sort_keys: Sequence[str], default_sort: str) -> Callable[..., Any]:
    allowed = tuple(allowed_sort_keys)
    default_terms = parse_sort(default_sort, allowed)
    sort_description = (
        f"Comma separated sort keys, a leading minus sorts descending. "
        f"Allowed: {', '.join(allowed)}. Default: {default_sort}."
    )

    async def dependency(
        request: Request,
        limit: Annotated[
            int, Query(ge=1, le=MAX_LIMIT, description="Page size, at most 200")
        ] = DEFAULT_LIMIT,
        cursor: Annotated[
            str | None,
            Query(
                max_length=MAX_CURSOR_LENGTH, description="Opaque next_cursor of a previous page"
            ),
        ] = None,
        include_total: Annotated[
            bool, Query(description="Count all matching rows into total")
        ] = False,
        sort: Annotated[str | None, Query(description=sort_description)] = None,
    ) -> PageQuery:
        await reject_unknown_query_parameters(request)
        terms = parse_sort(sort, allowed) if sort else default_terms
        return PageQuery(limit=limit, cursor=cursor, include_total=include_total, sort=terms)

    return dependency


def encode_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def decode_value(value: Any, value_type: type) -> Any:
    if value_type in {datetime, uuid.UUID} and not isinstance(value, str):
        raise ValueError("expected a string")
    if value_type is datetime:
        moment = datetime.fromisoformat(value)
        if moment.tzinfo is None:
            raise ValueError("expected a timestamp with an offset")
        return moment
    if value_type is uuid.UUID:
        return uuid.UUID(value)
    if value_type is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("expected an integer")
        return value
    if value_type is str:
        if not isinstance(value, str):
            raise ValueError("expected a string")
        return value
    return value


def invalid_cursor() -> ApiError:
    return unknown_parameter_error("cursor", "invalid_cursor", "The cursor is not valid")


def encode_cursor(sort_text: str, values: Sequence[Any]) -> str:
    payload = {CURSOR_SORT_FIELD: sort_text, CURSOR_VALUES_FIELD: [encode_value(v) for v in values]}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, sort_text: str, value_types: Sequence[type]) -> list[Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if payload[CURSOR_SORT_FIELD] != sort_text:
            raise ValueError("sort changed")
        raw_values = payload[CURSOR_VALUES_FIELD]
        if len(raw_values) != len(value_types):
            raise ValueError("wrong value count")
        return [decode_value(raw, kind) for raw, kind in zip(raw_values, value_types, strict=True)]
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeError):
        raise invalid_cursor() from None


def keyset_condition(
    expressions: Sequence[ColumnElement[Any]],
    descending: Sequence[bool],
    values: Sequence[Any],
) -> ColumnElement[bool]:
    branches: list[ColumnElement[bool]] = []
    for index, expression in enumerate(expressions):
        equal_before = [expressions[earlier] == values[earlier] for earlier in range(index)]
        after = expression < values[index] if descending[index] else expression > values[index]
        branches.append(and_(*equal_before, after))
    return or_(*branches)


async def paginate(
    session: AsyncSession,
    statement: Select[*tuple[Any, ...]],
    columns: Mapping[str, SortableColumn],
    id_column: SortableColumn,
    query: PageQuery,
) -> PageResult[Any]:
    sort_columns = [columns[term.key] for term in query.sort]
    id_descending = query.sort[0].descending
    expressions = [column.expression for column in sort_columns] + [id_column.expression]
    descending = [term.descending for term in query.sort] + [id_descending]
    value_types = [column.value_type for column in sort_columns] + [id_column.value_type]

    total: int | None = None
    if query.include_total:
        counted = select(func.count()).select_from(statement.order_by(None).subquery())
        total = int(await session.scalar(counted) or 0)

    page_statement = statement
    if query.cursor is not None:
        values = decode_cursor(query.cursor, query.sort_text, value_types)
        page_statement = page_statement.where(keyset_condition(expressions, descending, values))
    labels = [
        expression.label(f"_page_sort_{index}") for index, expression in enumerate(expressions)
    ]
    page_statement = page_statement.add_columns(*labels).order_by(
        *[
            expression.desc() if is_desc else expression.asc()
            for expression, is_desc in zip(expressions, descending, strict=True)
        ]
    )
    result = await session.execute(page_statement.limit(query.limit + 1))
    fetched = list(result.all())
    has_more = len(fetched) > query.limit
    rows = fetched[: query.limit]
    next_cursor: str | None = None
    if has_more:
        sort_values = tuple(rows[-1])[-len(expressions) :]
        next_cursor = encode_cursor(query.sort_text, sort_values)
    return PageResult(rows=rows, next_cursor=next_cursor, total=total)
