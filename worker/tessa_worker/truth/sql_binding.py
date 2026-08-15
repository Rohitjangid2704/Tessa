from dataclasses import dataclass

import sqlglot
from sqlglot import exp
from sqlglot.errors import ErrorLevel, SqlglotError

from tessa_api.services.oracle_lint import resolve_dialect
from tessa_worker.truth.oracle_errors import OracleExecutionError, OracleFailureCode

SUPPORTED_DIALECT = "postgres"


@dataclass(frozen=True, slots=True)
class BoundQuery:
    sql: str
    parameter_names: tuple[str, ...]


def parse_single_statement(sql: str) -> exp.Expr:
    try:
        statements = sqlglot.parse(sql, read=SUPPORTED_DIALECT, error_level=ErrorLevel.RAISE)
    except (SqlglotError, RecursionError) as error:
        raise OracleExecutionError(
            OracleFailureCode.sql_invalid, f"the query does not parse: {str(error)[:200]}"
        ) from None
    present = [statement for statement in statements if statement is not None]
    if len(present) != 1:
        raise OracleExecutionError(
            OracleFailureCode.sql_invalid,
            f"an oracle is exactly one statement, the file holds {len(present)}",
        )
    return present[0]


def bind_named_parameters(sql: str, dialect: str | None) -> BoundQuery:
    if resolve_dialect(dialect) != SUPPORTED_DIALECT:
        raise OracleExecutionError(
            OracleFailureCode.unsupported_dialect,
            f"the oracle runner executes {SUPPORTED_DIALECT} queries only, the truth source "
            f"declares {dialect or 'no dialect'}",
        )
    numbers: dict[str, int] = {}

    def to_positional(node: exp.Expr) -> exp.Expr:
        if not isinstance(node, exp.Placeholder):
            return node
        if not isinstance(node.this, str):
            raise OracleExecutionError(
                OracleFailureCode.sql_invalid,
                "positional placeholders are not allowed; write named parameters as :name",
            )
        number = numbers.setdefault(node.this, len(numbers) + 1)
        return exp.Parameter(this=exp.Literal.number(number))

    bound = parse_single_statement(sql).transform(to_positional)
    return BoundQuery(bound.sql(dialect=SUPPORTED_DIALECT), tuple(numbers))
