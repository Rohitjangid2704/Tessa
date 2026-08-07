import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from tessa_api.errors import ApiError
from tessa_api.schemas.common import ErrorDetail
from tessa_api.schemas.enums import CriterionKind
from tessa_api.schemas.goals import CRITERION_MAX_LENGTH, DEFAULT_CRITERION_KIND
from tessa_api.schemas.scenario import MAX_DB_RETRY_SECONDS, DbExpect, ExpectDb

CRITERIA_LOCATION = ("body", "success_criteria")
PREFIX_PATTERN = re.compile(
    rf"^(?P<kind>{'|'.join(kind.value for kind in CriterionKind)})\s*:\s*(?P<body>.*)$",
    re.IGNORECASE | re.DOTALL,
)
NEGATION_PATTERN = re.compile(r"^not\s+(?P<rest>\S.*)$", re.IGNORECASE | re.DOTALL)
QUOTED_PATTERN = re.compile(r'^"(?P<text>.+)"$', re.DOTALL)
REGEX_PATTERN = re.compile(r"^/(?P<pattern>.+)/(?P<flags>i?)$", re.DOTALL)
NESTED_QUANTIFIER_PATTERN = re.compile(r"\([^()]*[+*][^()]*\)\s*(?:[+*]|\{\d*,\d*\})")
TOOL_NAME_PATTERN = re.compile(r"^(?P<name>[A-Za-z0-9_][A-Za-z0-9_.:-]*)(?P<rest>.*)$", re.DOTALL)
ORACLE_NAME_PREFIX = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9_-]*)")
NUMBER_ASSERTION = re.compile(r"^(?P<key>row_count|min_rows|max_rows|retry)\s*=\s*(?P<value>\d+)")
LISTED_ASSERTION = re.compile(r"^(?P<key>first_row|rows)\s*=\s*")
MAX_REGEX_LENGTH = 200
DEFAULT_MIN_ROWS = 1
SNIPPET_LENGTH = 40
JSON_DECODER = json.JSONDecoder()


class CriterionSyntaxError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class CriterionBase(BaseModel):
    model_config = ConfigDict(frozen=True)

    source: str = Field(description="the entry as written")


class JudgeCriterion(CriterionBase):
    kind: Literal[CriterionKind.judge] = CriterionKind.judge
    statement: str


class TextCriterion(CriterionBase):
    kind: Literal[CriterionKind.text] = CriterionKind.text
    matcher: Literal["literal", "regex"]
    value: str
    ignore_case: bool
    negated: bool


class ToolCriterion(CriterionBase):
    kind: Literal[CriterionKind.tool] = CriterionKind.tool
    name: str
    args: dict[str, JsonValue]
    negated: bool


class DbCriterion(CriterionBase):
    kind: Literal[CriterionKind.db] = CriterionKind.db
    check: ExpectDb


ParsedCriterion = Annotated[
    JudgeCriterion | TextCriterion | ToolCriterion | DbCriterion, Field(discriminator="kind")
]


@dataclass(frozen=True, slots=True)
class CriterionProblem:
    index: int
    code: str
    message: str


@dataclass(slots=True)
class DbAssertions:
    row_count: int | None = None
    min_rows: int | None = None
    max_rows: int | None = None
    retry: int = 0
    first_row: dict[str, JsonValue] = field(default_factory=dict)
    rows: list[dict[str, JsonValue]] = field(default_factory=list)

    def set_number(self, key: str, value: int) -> None:
        match key:
            case "row_count":
                self.row_count = value
            case "min_rows":
                self.min_rows = value
            case "max_rows":
                self.max_rows = value
            case _:
                self.retry = value

    def asserts_nothing(self) -> bool:
        return (
            self.row_count is None
            and self.min_rows is None
            and self.max_rows is None
            and not self.first_row
            and not self.rows
        )


def snippet(text: str) -> str:
    return text[:SNIPPET_LENGTH]


def split_prefix(entry: str) -> tuple[CriterionKind, str]:
    found = PREFIX_PATTERN.match(entry)
    if found is None:
        return DEFAULT_CRITERION_KIND, entry
    return CriterionKind(found.group("kind").lower()), found.group("body").strip()


def split_negation(body: str) -> tuple[bool, str]:
    negation = NEGATION_PATTERN.match(body)
    if negation is None:
        return False, body
    return True, negation.group("rest").strip()


def unsafe_regex(pattern: str) -> bool:
    return len(pattern) > MAX_REGEX_LENGTH or NESTED_QUANTIFIER_PATTERN.search(pattern) is not None


def compile_regex(pattern: str, ignore_case: bool) -> None:
    if unsafe_regex(pattern):
        raise CriterionSyntaxError(
            "regex_not_allowed",
            f"the pattern must be at most {MAX_REGEX_LENGTH} characters and may not repeat a "
            "group that already repeats",
        )
    try:
        re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as error:
        raise CriterionSyntaxError("regex_invalid", f"the pattern is not valid: {error}") from None


def read_json(text: str, what: str) -> tuple[object, str]:
    try:
        value, end = JSON_DECODER.raw_decode(text)
    except json.JSONDecodeError as error:
        raise CriterionSyntaxError(
            "json_invalid", f"{what} is not valid JSON: {error.msg}"
        ) from None
    return value, text[end:].lstrip()


def read_json_object(text: str, what: str) -> tuple[dict[str, JsonValue], str]:
    value, remainder = read_json(text, what)
    if not isinstance(value, dict):
        raise CriterionSyntaxError("json_invalid", f"{what} must be a JSON object")
    return value, remainder


def read_json_rows(text: str, what: str) -> tuple[list[dict[str, JsonValue]], str]:
    value, remainder = read_json(text, what)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise CriterionSyntaxError("json_invalid", f"{what} must be a JSON array of objects")
    return value, remainder


def parse_judge(source: str, body: str) -> JudgeCriterion:
    if not body:
        raise CriterionSyntaxError("criterion_empty", "judge: needs a criterion in plain words")
    return JudgeCriterion(source=source, statement=body)


def parse_text(source: str, body: str) -> TextCriterion:
    negated, rest = split_negation(body)
    if not rest:
        raise CriterionSyntaxError("criterion_empty", "text: needs something to look for")
    regex = REGEX_PATTERN.match(rest)
    if regex is not None:
        ignore_case = bool(regex.group("flags"))
        compile_regex(regex.group("pattern"), ignore_case)
        return TextCriterion(
            source=source,
            matcher="regex",
            value=regex.group("pattern"),
            ignore_case=ignore_case,
            negated=negated,
        )
    quoted = QUOTED_PATTERN.match(rest)
    literal = quoted.group("text") if quoted is not None else rest
    return TextCriterion(
        source=source, matcher="literal", value=literal, ignore_case=True, negated=negated
    )


def parse_tool(source: str, body: str) -> ToolCriterion:
    negated, rest = split_negation(body)
    named = TOOL_NAME_PATTERN.match(rest)
    if named is None:
        raise CriterionSyntaxError("tool_name_missing", "tool: needs the name of a tool")
    remainder = named.group("rest").strip()
    args: dict[str, JsonValue] = {}
    if remainder:
        args, remainder = read_json_object(remainder, "the tool arguments")
    if remainder:
        raise CriterionSyntaxError(
            "unexpected_text", f"unexpected text after the tool arguments: {snippet(remainder)!r}"
        )
    return ToolCriterion(source=source, name=named.group("name"), args=args, negated=negated)


def read_assertions(text: str) -> DbAssertions:
    assertions = DbAssertions()
    rest = text
    while rest:
        number = NUMBER_ASSERTION.match(rest)
        if number is not None:
            assertions.set_number(number.group("key"), int(number.group("value")))
            rest = rest[number.end() :].lstrip()
            continue
        listed = LISTED_ASSERTION.match(rest)
        if listed is None:
            raise CriterionSyntaxError(
                "unexpected_text",
                "expected row_count=, min_rows=, max_rows=, first_row=, rows= or retry= at "
                f"{snippet(rest)!r}",
            )
        remainder = rest[listed.end() :]
        if listed.group("key") == "first_row":
            assertions.first_row, rest = read_json_object(remainder, "first_row")
        else:
            assertions.rows, rest = read_json_rows(remainder, "rows")
    return assertions


def build_expectation(assertions: DbAssertions) -> DbExpect:
    return DbExpect(
        row_count=assertions.row_count,
        min_rows=DEFAULT_MIN_ROWS if assertions.asserts_nothing() else assertions.min_rows,
        max_rows=assertions.max_rows,
        first_row=assertions.first_row,
        rows=assertions.rows,
    )


def parse_db(source: str, body: str) -> DbCriterion:
    named = ORACLE_NAME_PREFIX.match(body)
    if named is None:
        raise CriterionSyntaxError("oracle_missing", "db: starts with the name of an oracle")
    rest = body[named.end() :].strip()
    params: dict[str, JsonValue] = {}
    if rest.startswith("{"):
        params, rest = read_json_object(rest, "the oracle parameters")
    assertions = read_assertions(rest)
    if assertions.retry > MAX_DB_RETRY_SECONDS:
        raise CriterionSyntaxError(
            "retry_too_long", f"retry= is at most {MAX_DB_RETRY_SECONDS} seconds"
        )
    try:
        check = ExpectDb(
            oracle=named.group("name"),
            params=params,
            expect=build_expectation(assertions),
            retry_for_seconds=assertions.retry,
        )
    except ValidationError as error:
        first = error.errors(include_url=False)[0]
        raise CriterionSyntaxError("db_invalid", str(first["msg"])) from None
    return DbCriterion(source=source, check=check)


def parse_criterion(entry: str) -> ParsedCriterion:
    source = entry.strip()
    if not source:
        raise CriterionSyntaxError("criterion_empty", "a success criterion cannot be empty")
    if len(source) > CRITERION_MAX_LENGTH:
        raise CriterionSyntaxError(
            "criterion_too_long", f"a criterion is at most {CRITERION_MAX_LENGTH} characters"
        )
    kind, body = split_prefix(source)
    match kind:
        case CriterionKind.db:
            return parse_db(source, body)
        case CriterionKind.tool:
            return parse_tool(source, body)
        case CriterionKind.text:
            return parse_text(source, body)
        case CriterionKind.judge:
            return parse_judge(source, body)


def criterion_problems(
    entries: Sequence[str],
) -> tuple[list[ParsedCriterion], list[CriterionProblem]]:
    parsed: list[ParsedCriterion] = []
    problems: list[CriterionProblem] = []
    for index, entry in enumerate(entries):
        try:
            parsed.append(parse_criterion(entry))
        except CriterionSyntaxError as error:
            problems.append(CriterionProblem(index, error.code, error.message))
    return parsed, problems


def malformed_criteria_error(
    problems: Sequence[CriterionProblem], location: Sequence[str] = CRITERIA_LOCATION
) -> ApiError:
    details = [
        ErrorDetail(loc=[*location, problem.index], code=problem.code, message=problem.message)
        for problem in problems
    ]
    noun = "criterion is" if len(details) == 1 else "criteria are"
    return ApiError(422, "validation_failed", f"{len(details)} success {noun} malformed", details)


def validate_criteria(
    entries: Sequence[str], location: Sequence[str] = CRITERIA_LOCATION
) -> list[ParsedCriterion]:
    parsed, problems = criterion_problems(entries)
    if problems:
        raise malformed_criteria_error(problems, location)
    return parsed


def normalised_entries(entries: Sequence[str]) -> list[str]:
    return [entry.strip() for entry in entries]
