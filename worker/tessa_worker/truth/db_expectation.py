from collections.abc import Mapping, Sequence
from uuid import UUID

from pydantic import JsonValue

from tessa_api.schemas.enums import VerdictStatus
from tessa_api.schemas.oracles import DbCheck
from tessa_api.schemas.scenario import DbExpect

CONTEXT_ROWS = 5
Row = Mapping[str, JsonValue]


def is_number(value: JsonValue) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def values_equal(expected: JsonValue, actual: JsonValue) -> bool:
    if is_number(expected) and is_number(actual):
        return expected == actual
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            values_equal(left, right) for left, right in zip(expected, actual, strict=True)
        )
    if isinstance(expected, dict) and isinstance(actual, dict):
        return expected.keys() == actual.keys() and all(
            values_equal(value, actual[key]) for key, value in expected.items()
        )
    return type(expected) is type(actual) and expected == actual


def row_contains(row: Row, expected: Row) -> bool:
    return all(key in row and values_equal(value, row[key]) for key, value in expected.items())


def verdict_of(passed: bool) -> VerdictStatus:
    return VerdictStatus.pass_ if passed else VerdictStatus.fail


def count_check(
    name: str,
    expected: int,
    kept: int,
    status: VerdictStatus,
    oracle_result_id: UUID | None,
) -> DbCheck:
    return DbCheck(
        name=name,
        expected=expected,
        actual=kept,
        status=status,
        oracle_result_id=oracle_result_id,
    )


def exact_count_status(expected: int, kept: int, truncated: bool) -> VerdictStatus:
    if not truncated:
        return verdict_of(expected == kept)
    return VerdictStatus.fail if expected <= kept else VerdictStatus.uncertain


def minimum_count_status(minimum: int, kept: int, truncated: bool) -> VerdictStatus:
    if kept >= minimum:
        return VerdictStatus.pass_
    return VerdictStatus.uncertain if truncated else VerdictStatus.fail


def maximum_count_status(maximum: int, kept: int, truncated: bool) -> VerdictStatus:
    if kept > maximum:
        return VerdictStatus.fail
    return VerdictStatus.uncertain if truncated else VerdictStatus.pass_


def row_count_checks(
    expect: DbExpect, kept: int, truncated: bool, oracle_result_id: UUID | None
) -> list[DbCheck]:
    checks: list[DbCheck] = []
    if isinstance(expect.row_count, int):
        status = exact_count_status(expect.row_count, kept, truncated)
        checks.append(count_check("row_count", expect.row_count, kept, status, oracle_result_id))
    if isinstance(expect.min_rows, int):
        status = minimum_count_status(expect.min_rows, kept, truncated)
        checks.append(count_check("min_rows", expect.min_rows, kept, status, oracle_result_id))
    if isinstance(expect.max_rows, int):
        status = maximum_count_status(expect.max_rows, kept, truncated)
        checks.append(count_check("max_rows", expect.max_rows, kept, status, oracle_result_id))
    return checks


def first_row_checks(
    expect: DbExpect, rows: Sequence[Row], oracle_result_id: UUID | None
) -> list[DbCheck]:
    first = rows[0] if rows else None
    return [
        DbCheck(
            name=f"first_row.{column}",
            expected=value,
            actual=first.get(column) if first is not None else None,
            status=verdict_of(
                first is not None and column in first and values_equal(value, first[column])
            ),
            oracle_result_id=oracle_result_id,
        )
        for column, value in expect.first_row.items()
    ]


def listed_row_checks(
    expect: DbExpect, rows: Sequence[Row], oracle_result_id: UUID | None
) -> list[DbCheck]:
    unmatched = list(range(len(rows)))
    checks: list[DbCheck] = []
    for position, wanted in enumerate(expect.rows):
        found = next((index for index in unmatched if row_contains(rows[index], wanted)), None)
        if found is not None:
            unmatched.remove(found)
        actual: JsonValue = (
            dict(rows[found]) if found is not None else [dict(row) for row in rows[:CONTEXT_ROWS]]
        )
        checks.append(
            DbCheck(
                name=f"rows[{position}]",
                expected=wanted,
                actual=actual,
                status=verdict_of(found is not None),
                oracle_result_id=oracle_result_id,
            )
        )
    return checks


def evaluate_db_expectation(
    expect: DbExpect,
    rows: Sequence[Row],
    rows_truncated: bool,
    oracle_result_id: UUID | None,
) -> list[DbCheck]:
    return [
        *row_count_checks(expect, len(rows), rows_truncated, oracle_result_id),
        *first_row_checks(expect, rows, oracle_result_id),
        *listed_row_checks(expect, rows, oracle_result_id),
    ]


def expectation_holds(expect: DbExpect, rows: Sequence[Row], rows_truncated: bool) -> bool:
    checks = evaluate_db_expectation(expect, rows, rows_truncated, None)
    return bool(checks) and all(check.status is VerdictStatus.pass_ for check in checks)
