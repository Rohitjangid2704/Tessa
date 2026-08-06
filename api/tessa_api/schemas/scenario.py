from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, JsonValue, model_validator

from tessa_api.schemas.bundle import SLUG_PATTERN, section_config
from tessa_api.schemas.bundle import manifest_field as ui_field
from tessa_api.schemas.bundle_files import (
    ACTIONS_NEEDING_TARGET,
    ACTIONS_NEEDING_URL,
    ACTIONS_NEEDING_VALUE,
    ORACLE_NAME_PATTERN,
)
from tessa_api.schemas.bundle_references import ManifestProblem, to_validation_error

SCENARIO_SCHEMA_VERSION = 1
ANONYMOUS_IDENTITY = "anonymous"
REQUEST_PATH_PATTERN = r"^/([^/\s]\S*)?$"
FIELD_PATH_PATTERN = r"^(\$\.?)?([A-Za-z0-9_-]+|\[\d+\])(\.[A-Za-z0-9_-]+|\[\d+\])*$"
MAX_DB_RETRY_SECONDS = 60
GOLD_REFERENCE_VALUE_PATTERN = r"^\$\{gold\.[a-z][a-z0-9_]*\}$"
GRAPHQL_NAME_PATTERN = r"^[_A-Za-z][_0-9A-Za-z]*$"
MAX_STEP_OFFSET_MS = 60000
MAX_STEP_MESSAGES = 100
MAX_GRAPHQL_DOCUMENT_CHARS = 20000

HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
HttpStatus = Annotated[int, Field(ge=100, le=599)]
FieldType = Literal["string", "number", "integer", "boolean", "array", "object", "null"]
BrowserAction = Literal["goto", "click", "fill", "press", "select", "check", "hover", "wait_for"]
ConsoleLevel = Literal["error", "warning"]
QueryScalar = str | int | float | bool
QueryValue = QueryScalar | list[QueryScalar]
RowBound = Annotated[int, Field(ge=0)] | Annotated[str, Field(pattern=GOLD_REFERENCE_VALUE_PATTERN)]


def header_field(
    title: str,
    description: str,
    examples: list[Any],
    order: int,
    widget: Literal["text", "textarea", "select", "chips", "yaml", "number", "toggle"] = "text",
    **options: Any,
) -> Any:
    return ui_field(title, description, examples, "Scenario", order, widget, **options)


def step_field(
    title: str,
    description: str,
    examples: list[Any],
    order: int,
    widget: Literal["text", "textarea", "select", "chips", "yaml", "number", "toggle"] = "text",
    **options: Any,
) -> Any:
    return ui_field(title, description, examples, "Step", order, widget, **options)


def expect_field(
    title: str,
    description: str,
    examples: list[Any],
    order: int,
    widget: Literal["text", "textarea", "select", "chips", "yaml", "number", "toggle"] = "yaml",
    **options: Any,
) -> Any:
    return ui_field(title, description, examples, "Expect", order, widget, **options)


class CellRef(BaseModel):
    model_config = section_config(
        "Cell", "The coverage cell a scenario belongs to: one role on one interface.", "forbid"
    )

    role: str = header_field(
        "Role", "Manifest role id of the cell.", ["staff"], 1, pattern=SLUG_PATTERN
    )
    interface_id: str = header_field(
        "Interface id",
        "Manifest interface id of the cell.",
        ["chat_sse"],
        2,
        pattern=SLUG_PATTERN,
    )


class RequestSpec(BaseModel):
    model_config = section_config(
        "Request",
        "A request to an interface of the target. The address is the interface base plus path.",
        "forbid",
    )

    method: HttpMethod = step_field("Method", "HTTP method.", ["GET"], 1, "select")
    path: str = step_field(
        "Path",
        "Path below the interface address, starting with one slash; ${NAME} placeholders allowed.",
        ["/api/rooms"],
        2,
        pattern=REQUEST_PATH_PATTERN,
    )
    headers: dict[str, str] = step_field(
        "Headers",
        "Extra request headers; secrets are written as ${NAME} placeholders.",
        [{"Accept": "application/json"}],
        3,
        "yaml",
        default_factory=dict,
    )
    query: dict[str, QueryValue] = step_field(
        "Query",
        "Query parameters; a list value repeats the parameter.",
        [{"limit": 5}],
        4,
        "yaml",
        default_factory=dict,
    )
    body: JsonValue = step_field(
        "Body",
        "JSON body of the request; null sends none.",
        [{"message": "Which maintenance issues are still open?"}],
        5,
        "yaml",
        default=None,
    )


class FieldCheck(BaseModel):
    model_config = section_config(
        "Field check",
        "One assertion about a value inside the parsed JSON response body; at least one "
        "assertion besides path is required. A null equals is no assertion: use type null.",
        "forbid",
    )

    path: str = expect_field(
        "Path",
        "Dotted path from the body root with [n] array indexes; a leading $. is accepted.",
        ["items[0].id", "$.total"],
        1,
        "text",
        pattern=FIELD_PATH_PATTERN,
    )
    exists: bool | None = expect_field(
        "Exists",
        "true when the path must exist, false when it must not.",
        [True],
        2,
        "toggle",
        default=None,
    )
    equals: JsonValue = expect_field(
        "Equals",
        "Value the field must equal; to assert null use type null.",
        ["open"],
        3,
        "text",
        default=None,
    )
    type: FieldType | None = expect_field(
        "Type", "JSON type the value must have.", ["string"], 4, "select", default=None
    )
    matches: str | None = expect_field(
        "Matches",
        "Regular expression the string value must match.",
        ["^[A-Z]{3}-\\d+$"],
        5,
        "text",
        default=None,
    )
    min_length: int | None = expect_field(
        "Minimum length", "Shortest accepted string or array.", [1], 6, "number", default=None, ge=0
    )
    max_length: int | None = expect_field(
        "Maximum length",
        "Longest accepted string or array.",
        [100],
        7,
        "number",
        default=None,
        ge=0,
    )
    gte: float | None = expect_field(
        "At least", "Smallest accepted number.", [0], 8, "number", default=None
    )
    lte: float | None = expect_field(
        "At most", "Largest accepted number.", [100], 9, "number", default=None
    )

    @model_validator(mode="after")
    def asserts_something(self) -> Self:
        assertions = (
            self.exists,
            self.equals,
            self.type,
            self.matches,
            self.min_length,
            self.max_length,
            self.gte,
            self.lte,
        )
        if all(assertion is None for assertion in assertions):
            raise to_validation_error(
                "FieldCheck",
                [
                    ManifestProblem(
                        code="field_check_empty",
                        message="A field check needs at least one assertion besides path",
                        loc=(),
                    )
                ],
            )
        return self


class HttpLatencyExpect(BaseModel):
    model_config = section_config(
        "HTTP latency", "Upper bound on the time the response took.", "forbid"
    )

    max_ms: int = expect_field(
        "Maximum", "Slowest accepted response time in milliseconds.", [2000], 1, "number", ge=1
    )


class SseLatencyExpect(BaseModel):
    model_config = section_config(
        "SSE latency", "Upper bounds on a stream: time to the first event and total time.", "forbid"
    )

    max_ms: int | None = expect_field(
        "Maximum total",
        "Slowest accepted total stream time in milliseconds.",
        [30000],
        1,
        "number",
        default=None,
        ge=1,
    )
    max_first_byte_ms: int | None = expect_field(
        "Maximum first byte",
        "Slowest accepted time to the first event in milliseconds.",
        [5000],
        2,
        "number",
        default=None,
        ge=1,
    )

    @model_validator(mode="after")
    def bounds_something(self) -> Self:
        if self.max_ms is None and self.max_first_byte_ms is None:
            raise to_validation_error(
                "SseLatencyExpect",
                [
                    ManifestProblem(
                        code="latency_empty",
                        message="Set max_ms, max_first_byte_ms or both",
                        loc=(),
                    )
                ],
            )
        return self


class ToolMatch(BaseModel):
    model_config = section_config(
        "Tool match",
        "A tool call to look for: its name, and optionally arguments it must carry.",
        "forbid",
    )

    name: str = expect_field("Name", "Tool name.", ["search_documents"], 1, "text", min_length=1)
    args: dict[str, JsonValue] = expect_field(
        "Arguments",
        "Arguments the call must contain; each listed value must equal the call's value.",
        [{"room": "20003"}],
        2,
        "yaml",
        default_factory=dict,
    )


ToolRef = str | ToolMatch


class EventsExpect(BaseModel):
    model_config = section_config(
        "Stream events", "Event names the stream must or must not contain.", "forbid"
    )

    include: list[str] = expect_field(
        "Include", "Event names that must appear.", [["done"]], 1, "chips", default_factory=list
    )
    exclude: list[str] = expect_field(
        "Exclude",
        "Event names that must not appear.",
        [["error"]],
        2,
        "chips",
        default_factory=list,
    )


class ToolsExpect(BaseModel):
    model_config = section_config(
        "Tools", "Expectations about the tools the system under test called.", "forbid"
    )

    include: list[ToolRef] = expect_field(
        "Include",
        "Tools that must have been called; a bare name matches any arguments.",
        [["search_documents"]],
        1,
        default_factory=list,
    )
    exclude: list[ToolRef] = expect_field(
        "Exclude",
        "Tools that must not have been called; with args only a call carrying them counts.",
        [["query_rooms"]],
        2,
        default_factory=list,
    )
    none: bool = expect_field(
        "None",
        "True when the step must call no tool at all.",
        [True],
        3,
        "toggle",
        default=False,
    )
    at_least_one: bool = expect_field(
        "At least one",
        "True when the step must call some tool.",
        [True],
        4,
        "toggle",
        default=False,
    )
    max_calls: int | None = expect_field(
        "Maximum calls", "Most tool calls accepted.", [3], 5, "number", default=None, ge=0
    )

    @model_validator(mode="after")
    def agrees_with_itself(self) -> Self:
        problems: list[ManifestProblem] = []
        if self.none and (self.include or self.at_least_one):
            problems.append(
                ManifestProblem(
                    code="tools_contradiction",
                    message="none contradicts include and at_least_one",
                    loc=("none",),
                )
            )
        if self.none and self.max_calls not in (None, 0):
            problems.append(
                ManifestProblem(
                    code="tools_contradiction",
                    message="none contradicts a max_calls above zero",
                    loc=("max_calls",),
                )
            )
        if problems:
            raise to_validation_error("ToolsExpect", problems)
        return self


class CardsExpect(BaseModel):
    model_config = section_config(
        "Cards", "Expectations about the structured cards the system under test showed.", "forbid"
    )

    min_count: int | None = expect_field(
        "Minimum count", "Fewest cards accepted.", [1], 1, "number", default=None, ge=0
    )
    max_count: int | None = expect_field(
        "Maximum count", "Most cards accepted.", [3], 2, "number", default=None, ge=0
    )
    include: list[dict[str, JsonValue]] = expect_field(
        "Include",
        "Cards that must be present; a card matches when it carries every listed key and value.",
        [[{"kind": "confirmation"}]],
        3,
        default_factory=list,
    )


class BrowserTarget(BaseModel):
    model_config = section_config(
        "Browser target",
        "The element a step acts on: an accessibility role with its name, or a stable selector.",
        "forbid",
    )

    role: str | None = step_field(
        "Role", "Accessibility role of the element.", ["button"], 1, default=None
    )
    name: str | None = step_field(
        "Name", "Accessible name of the element.", ["Send"], 2, default=None
    )
    selector: str | None = step_field(
        "Selector",
        "Stable selector such as [data-testid=send].",
        ["[data-testid=send]"],
        3,
        default=None,
    )

    @model_validator(mode="after")
    def names_the_element_one_way(self) -> Self:
        named_by_role = self.role is not None and self.name is not None
        half_a_role = (self.role is None) != (self.name is None)
        if half_a_role or named_by_role == (self.selector is not None):
            raise to_validation_error(
                "BrowserTarget",
                [
                    ManifestProblem(
                        code="target_ambiguous",
                        message="A target is either role and name together, or a selector",
                        loc=(),
                    )
                ],
            )
        return self

    def key(self) -> str:
        if self.selector is not None:
            return f"selector={self.selector}"
        return f"role={self.role} name={self.name}"


class DomStateExpect(BaseModel):
    model_config = section_config("Page state", "What the page must show after the step.", "forbid")

    url: str | None = expect_field(
        "URL",
        "Path or address the page must be at; a path matches the end of the page address.",
        ["/rooms"],
        1,
        "text",
        default=None,
    )
    title_contains: str | None = expect_field(
        "Title contains", "Text the page title must contain.", ["Rooms"], 2, "text", default=None
    )
    text_contains: list[str] = expect_field(
        "Text contains",
        "Texts that must be visible on the page.",
        [["Issue created"]],
        3,
        "chips",
        default_factory=list,
    )
    text_not_contains: list[str] = expect_field(
        "Text not contains",
        "Texts that must not be visible on the page.",
        [["Error"]],
        4,
        "chips",
        default_factory=list,
    )
    visible: list[BrowserTarget] = expect_field(
        "Visible",
        "Elements that must be visible.",
        [[{"role": "button", "name": "Confirm"}]],
        5,
        default_factory=list,
    )
    hidden: list[BrowserTarget] = expect_field(
        "Hidden",
        "Elements that must be hidden or absent.",
        [[{"selector": "[data-testid=error]"}]],
        6,
        default_factory=list,
    )

    @model_validator(mode="after")
    def expects_something(self) -> Self:
        if not (
            self.url
            or self.title_contains
            or self.text_contains
            or self.text_not_contains
            or self.visible
            or self.hidden
        ):
            raise to_validation_error(
                "DomStateExpect",
                [
                    ManifestProblem(
                        code="dom_state_empty",
                        message="A page state expectation needs at least one condition",
                        loc=(),
                    )
                ],
            )
        return self


class ConsoleExpect(BaseModel):
    model_config = section_config(
        "Console", "Which browser console messages fail the step.", "forbid"
    )

    fail_on: list[ConsoleLevel] = expect_field(
        "Fail on",
        "Console levels that fail the step.",
        [["error"]],
        1,
        "chips",
        default_factory=lambda: ["error"],
        min_length=1,
    )
    allow: list[str] = expect_field(
        "Allow",
        "Regular expressions; a message matching one of them never fails the step.",
        [["favicon\\.ico"]],
        2,
        "chips",
        default_factory=list,
    )


class HttpExpect(BaseModel):
    model_config = section_config(
        "HTTP expectations", "What a response of an http step must look like.", "forbid"
    )

    status: HttpStatus | list[HttpStatus] | None = expect_field(
        "Status",
        "Accepted status code or codes; when absent the status check does not run.",
        [200, [200, 201]],
        1,
        "text",
        default=None,
    )
    body_schema: dict[str, JsonValue] | None = expect_field(
        "Body schema",
        "JSON Schema the parsed body must satisfy.",
        [{"type": "object", "required": ["items"]}],
        2,
        default=None,
        alias="schema",
    )
    fields: list[FieldCheck] = expect_field(
        "Fields",
        "Assertions about values inside the body.",
        [[{"path": "items", "min_length": 1}]],
        3,
        default_factory=list,
    )
    latency: HttpLatencyExpect | None = expect_field(
        "Latency", "Upper bound on the response time.", [{"max_ms": 2000}], 4, default=None
    )
    internal_ids: bool = expect_field(
        "Internal ids",
        "True checks that the body shows no internal identifiers.",
        [True],
        5,
        "toggle",
        default=True,
    )
    free_text: str | None = expect_field(
        "Free text",
        "What the response should show, in words, kept for model grading in a later stage.",
        ["A page of rooms"],
        6,
        "textarea",
        default=None,
        max_length=4000,
    )


class SseExpect(BaseModel):
    model_config = section_config(
        "SSE expectations", "What the stream of an sse step must look like.", "forbid"
    )

    status: HttpStatus | list[HttpStatus] | None = expect_field(
        "Status",
        "Accepted status code or codes of the stream response; also reports event expectations.",
        [200],
        1,
        "text",
        default=None,
    )
    events: EventsExpect | None = expect_field(
        "Events",
        "Event names the stream must or must not contain.",
        [{"include": ["done"]}],
        2,
        default=None,
    )
    tools: ToolsExpect | None = expect_field(
        "Tools",
        "Expectations about the tool calls.",
        [{"include": ["search_documents"]}],
        3,
        default=None,
    )
    cards: CardsExpect | None = expect_field(
        "Cards", "Expectations about the cards shown.", [{"min_count": 1}], 4, default=None
    )
    text_contains: list[str] = expect_field(
        "Text contains",
        "Texts the answer must contain, ignoring case.",
        [["two pets"]],
        5,
        "chips",
        default_factory=list,
    )
    text_contains_any: list[str] = expect_field(
        "Text contains any",
        "The answer must contain at least one of these texts, ignoring case.",
        [["no late check-out fee", "does not state a late check-out fee"]],
        6,
        "chips",
        default_factory=list,
    )
    text_not_contains: list[str] = expect_field(
        "Text not contains",
        "Texts the answer must not contain, ignoring case.",
        [["I have created"]],
        7,
        "chips",
        default_factory=list,
    )
    non_empty_answer: bool = expect_field(
        "Non-empty answer",
        "True fails the step when the answer the adapter extracted is empty, reported as a "
        "text_contains failure; an answer the adapter could not extract (null) never fails.",
        [True],
        8,
        "toggle",
        default=True,
    )
    latency: SseLatencyExpect | None = expect_field(
        "Latency",
        "Upper bounds on the stream times.",
        [{"max_first_byte_ms": 5000}],
        9,
        default=None,
    )
    internal_ids: bool = expect_field(
        "Internal ids",
        "True checks that the answer shows no internal identifiers.",
        [True],
        10,
        "toggle",
        default=True,
    )
    free_text: str | None = expect_field(
        "Free text",
        "What the answer should say, in words, kept for model grading in a later stage.",
        ["Count of open items and the rooms with the most"],
        11,
        "textarea",
        default=None,
        max_length=4000,
    )


class BrowserExpect(BaseModel):
    model_config = section_config(
        "Browser expectations", "What the page must look like after a browser step.", "forbid"
    )

    dom_state: DomStateExpect | None = expect_field(
        "Page state",
        "What the page must show.",
        [{"url": "/rooms", "text_contains": ["Rooms"]}],
        1,
        default=None,
    )
    console: ConsoleExpect | None = expect_field(
        "Console",
        "Which console messages fail the step.",
        [{"fail_on": ["error"]}],
        2,
        default=None,
    )
    free_text: str | None = expect_field(
        "Free text",
        "What the page should show, in words, kept for model grading in a later stage.",
        ["The issue appears in the list"],
        3,
        "textarea",
        default=None,
        max_length=4000,
    )


class GoldFrom(BaseModel):
    model_config = section_config(
        "Gold source",
        "Runs an approved oracle just before the step. Its gold points become available as "
        "${gold.<key>} in the expectations of this step and of every later step.",
        "forbid",
    )

    oracle: str = step_field(
        "Oracle",
        "Name of an oracle of the bundle (oracle/<name>.yaml).",
        ["open_maintenance"],
        1,
        pattern=ORACLE_NAME_PATTERN,
    )
    params: dict[str, JsonValue] = step_field(
        "Parameters",
        "Values for the oracle parameters. Parameters with an x-source (clock, role, literal) "
        "or a default are supplied when absent; ${NAME} placeholders resolve from the target "
        "environment.",
        [{"tenant_id": "${QA_TENANT_ID}"}],
        2,
        "yaml",
        default_factory=dict,
    )


class DbExpect(BaseModel):
    model_config = section_config(
        "Database expectation",
        "What the rows of the oracle must look like after the step; at least one assertion is "
        "required. ${gold.<key>} references are allowed in the values.",
        "forbid",
    )

    row_count: RowBound | None = expect_field(
        "Row count",
        "Exact number of rows the oracle must return, or a ${gold.<key>} reference.",
        [1, "${gold.open_count}"],
        1,
        "text",
        default=None,
    )
    min_rows: RowBound | None = expect_field(
        "Minimum rows",
        "Fewest rows the oracle may return, or a ${gold.<key>} reference.",
        [1],
        2,
        "text",
        default=None,
    )
    max_rows: RowBound | None = expect_field(
        "Maximum rows",
        "Most rows the oracle may return, or a ${gold.<key>} reference.",
        [10],
        3,
        "text",
        default=None,
    )
    first_row: dict[str, JsonValue] = expect_field(
        "First row",
        "Columns the first row must carry with exactly these values.",
        [{"status": "open"}],
        4,
        "yaml",
        default_factory=dict,
    )
    rows: list[dict[str, JsonValue]] = expect_field(
        "Rows",
        "Rows that must be present in any order; each entry matches a different row that carries "
        "every listed column with exactly that value.",
        [[{"room": "20003", "open_issues": 2}]],
        5,
        "yaml",
        default_factory=list,
    )

    @model_validator(mode="after")
    def asserts_something_consistent(self) -> Self:
        problems: list[ManifestProblem] = []
        asserts_nothing = (
            self.row_count is None
            and self.min_rows is None
            and self.max_rows is None
            and not self.first_row
            and not self.rows
        )
        if asserts_nothing:
            problems.append(
                ManifestProblem(
                    code="db_expect_empty",
                    message="A database expectation needs row_count, min_rows, max_rows, "
                    "first_row or rows",
                    loc=(),
                )
            )
        if (
            isinstance(self.min_rows, int)
            and isinstance(self.max_rows, int)
            and self.min_rows > self.max_rows
        ):
            problems.append(
                ManifestProblem(
                    code="db_expect_range_empty",
                    message="min_rows is above max_rows",
                    loc=("min_rows",),
                )
            )
        if problems:
            raise to_validation_error("DbExpect", problems)
        return self


class ExpectDb(BaseModel):
    model_config = section_config(
        "Database check",
        "Runs an approved oracle after the step and checks its rows against the expectation, "
        "retrying until retry_for_seconds have passed so asynchronous writes can land.",
        "forbid",
    )

    oracle: str = step_field(
        "Oracle",
        "Name of an oracle of the bundle (oracle/<name>.yaml).",
        ["issue_by_title"],
        1,
        pattern=ORACLE_NAME_PATTERN,
    )
    params: dict[str, JsonValue] = step_field(
        "Parameters",
        "Values for the oracle parameters; same rules as gold_from.",
        [{"title": "Broken lamp"}],
        2,
        "yaml",
        default_factory=dict,
    )
    expect: DbExpect = step_field(
        "Expect",
        "What the oracle rows must look like.",
        [{"row_count": 1}],
        3,
        "yaml",
    )
    retry_for_seconds: int = step_field(
        "Retry for",
        "Seconds to keep re-running the oracle while the expectation does not hold yet.",
        [5],
        4,
        "number",
        default=0,
        ge=0,
        le=MAX_DB_RETRY_SECONDS,
    )


class StepBase(BaseModel):
    label: str | None = step_field(
        "Label",
        "Short description shown in the step list; a default is derived when absent.",
        ["List open maintenance issues"],
        1,
        default=None,
        max_length=200,
    )
    as_: str | None = step_field(
        "As",
        "Run this step under another identity: anonymous or a role id. Absent uses the "
        "scenario role.",
        ["anonymous"],
        2,
        default=None,
        alias="as",
        pattern=SLUG_PATTERN,
    )
    gold_from: GoldFrom | None = step_field(
        "Gold from",
        "Oracle to run before the step; its gold points feed ${gold.<key>} references in "
        "text_contains, fields and expect_db.expect.",
        [{"oracle": "open_maintenance"}],
        20,
        "yaml",
        default=None,
    )
    expect_db: ExpectDb | None = step_field(
        "Expect database",
        "Oracle check run after the step against the truth database.",
        [{"oracle": "issue_by_title", "expect": {"row_count": 1}, "retry_for_seconds": 5}],
        21,
        "yaml",
        default=None,
    )


class HttpStep(StepBase):
    model_config = section_config(
        "HTTP step",
        "One request to an http interface and what the response must look like.",
        "forbid",
    )

    adapter: Literal["http"] = step_field("Adapter", "Step kind.", ["http"], 3, "select")
    request: RequestSpec = step_field(
        "Request", "The request to send.", [{"method": "GET", "path": "/api/rooms"}], 4, "yaml"
    )
    expect: HttpExpect = step_field(
        "Expect",
        "What the response must look like.",
        [{"status": 200}],
        5,
        "yaml",
        default_factory=HttpExpect,
    )


class SseStep(StepBase):
    model_config = section_config(
        "SSE step",
        "One request to a streaming interface, usually a chat, and what the stream must look like.",
        "forbid",
    )

    adapter: Literal["sse"] = step_field("Adapter", "Step kind.", ["sse"], 3, "select")
    ask: str | None = step_field(
        "Ask",
        "The natural language input, recorded as the ask of the step; the request carries it too.",
        ["Which maintenance issues are still open?"],
        4,
        "textarea",
        default=None,
    )
    request: RequestSpec = step_field(
        "Request",
        "The request that opens the stream.",
        [{"method": "POST", "path": "/api/chat", "body": {"message": "Hello"}}],
        5,
        "yaml",
    )
    expect: SseExpect = step_field(
        "Expect",
        "What the stream must look like.",
        [{"status": 200}],
        6,
        "yaml",
        default_factory=SseExpect,
    )


class BrowserStep(StepBase):
    model_config = section_config(
        "Browser step",
        "One action in a real browser page and what the page must show after it.",
        "forbid",
    )

    adapter: Literal["browser"] = step_field("Adapter", "Step kind.", ["browser"], 3, "select")
    action: BrowserAction = step_field(
        "Action",
        "goto opens url; click, check and hover act on target; fill and select act on target "
        "with value; press sends the key in value; wait_for only waits for expect to hold.",
        ["click"],
        4,
        "select",
    )
    url: str | None = step_field(
        "URL", "Path or address to open, for goto.", ["/login"], 5, default=None
    )
    target: BrowserTarget | None = step_field(
        "Target",
        "The element to act on.",
        [{"role": "button", "name": "Send"}],
        6,
        "yaml",
        default=None,
    )
    value: str | None = step_field(
        "Value",
        "Text to type, option to pick or key to press; secrets are ${NAME} placeholders.",
        ["${STAFF_EMAIL}"],
        7,
        default=None,
    )
    expect: BrowserExpect = step_field(
        "Expect",
        "What the page must show after the step.",
        [{"dom_state": {"url": "/"}}],
        8,
        "yaml",
        default_factory=BrowserExpect,
    )

    @model_validator(mode="after")
    def action_has_what_it_needs(self) -> Self:
        problems: list[ManifestProblem] = []
        if self.action in ACTIONS_NEEDING_URL and self.url is None:
            problems.append(
                ManifestProblem("step_url_required", f"Action {self.action} needs url", ("url",))
            )
        if self.action in ACTIONS_NEEDING_TARGET and self.target is None:
            problems.append(
                ManifestProblem(
                    "step_target_required", f"Action {self.action} needs target", ("target",)
                )
            )
        if self.action in ACTIONS_NEEDING_VALUE and self.value is None:
            problems.append(
                ManifestProblem(
                    "step_value_required", f"Action {self.action} needs value", ("value",)
                )
            )
        if self.action == "wait_for" and self.expect.dom_state is None:
            problems.append(
                ManifestProblem(
                    "step_expect_required",
                    "Action wait_for needs expect.dom_state to wait for",
                    ("expect", "dom_state"),
                )
            )
        if problems:
            raise to_validation_error("BrowserStep", problems)
        return self


class MessageFieldCheck(FieldCheck):
    model_config = section_config(
        "Message field check",
        "One assertion about a value inside a received message that parses as JSON; at least one "
        "assertion besides path is required.",
        "forbid",
    )

    message: int | None = expect_field(
        "Message",
        "Index of the received message the check applies to, from 0; absent means some received "
        "message must satisfy it.",
        [0],
        10,
        "number",
        default=None,
        ge=0,
    )


class WebsocketMessageSpec(BaseModel):
    model_config = section_config(
        "WebSocket message", "One message the step sends after the connection opens.", "forbid"
    )

    at_ms: int = step_field(
        "At",
        "Milliseconds after the connection opened at which the message is sent.",
        [0],
        1,
        "number",
        default=0,
        ge=0,
        le=MAX_STEP_OFFSET_MS,
    )
    data: JsonValue = step_field(
        "Data",
        "Message to send: text is sent as it is, any other JSON value as its compact JSON text; "
        "secrets are ${NAME} placeholders.",
        [{"type": "subscribe", "room": "20003"}],
        2,
        "yaml",
    )


class WebsocketExpect(BaseModel):
    model_config = section_config(
        "WebSocket expectations", "What the connection of a websocket step must show.", "forbid"
    )

    close_code: int | list[int] | None = expect_field(
        "Close code",
        "Accepted close code or codes; absent accepts a normal close (1000 or 1001) or a "
        "connection still open when listening ends.",
        [1000],
        1,
        "text",
        default=None,
    )
    min_messages: int | None = expect_field(
        "Minimum messages",
        "Fewest messages the step must receive.",
        [1],
        2,
        "number",
        default=None,
        ge=0,
    )
    max_messages: int | None = expect_field(
        "Maximum messages",
        "Most messages the step may receive.",
        [20],
        3,
        "number",
        default=None,
        ge=0,
    )
    fields: list[MessageFieldCheck] = expect_field(
        "Fields",
        "Assertions about values inside received messages that parse as JSON.",
        [[{"path": "type", "equals": "ack", "message": 0}]],
        4,
        default_factory=list,
    )
    text_contains: list[str] = expect_field(
        "Text contains",
        "Texts the received messages must contain together, ignoring case.",
        [["subscribed"]],
        5,
        "chips",
        default_factory=list,
    )
    text_not_contains: list[str] = expect_field(
        "Text not contains",
        "Texts no received message may contain, ignoring case.",
        [["error"]],
        6,
        "chips",
        default_factory=list,
    )
    latency: SseLatencyExpect | None = expect_field(
        "Latency",
        "Upper bounds on the step times: max_first_byte_ms is the time to the first message.",
        [{"max_first_byte_ms": 2000}],
        7,
        default=None,
    )
    internal_ids: bool = expect_field(
        "Internal ids",
        "True checks that the received messages show no internal identifiers.",
        [True],
        8,
        "toggle",
        default=True,
    )
    free_text: str | None = expect_field(
        "Free text",
        "What the messages should say, in words, kept for model grading in a later stage.",
        ["A room update for room 20003"],
        9,
        "textarea",
        default=None,
        max_length=4000,
    )


class WebsocketStep(StepBase):
    model_config = section_config(
        "WebSocket step",
        "Opens a connection to a websocket interface, sends messages and checks what comes back.",
        "forbid",
    )

    adapter: Literal["websocket"] = step_field("Adapter", "Step kind.", ["websocket"], 3, "select")
    path: str | None = step_field(
        "Path",
        "Path below the interface address to connect to; absent connects to the interface address.",
        ["/ws/rooms"],
        4,
        default=None,
        pattern=REQUEST_PATH_PATTERN,
    )
    messages: list[WebsocketMessageSpec] = step_field(
        "Messages",
        "Messages to send, in order.",
        [[{"at_ms": 0, "data": {"type": "subscribe", "room": "20003"}}]],
        5,
        "yaml",
        default_factory=list,
        max_length=MAX_STEP_MESSAGES,
    )
    listen_ms: int = step_field(
        "Listen",
        "Milliseconds to keep reading after the last message was sent.",
        [2000],
        6,
        "number",
        default=2000,
        ge=0,
        le=MAX_STEP_OFFSET_MS,
    )
    expect: WebsocketExpect = step_field(
        "Expect",
        "What the connection must show.",
        [{"min_messages": 1}],
        7,
        "yaml",
        default_factory=WebsocketExpect,
    )


class GraphqlExpect(BaseModel):
    model_config = section_config(
        "GraphQL expectations", "What the response of a graphql step must look like.", "forbid"
    )

    status: HttpStatus | list[HttpStatus] | None = expect_field(
        "Status",
        "Accepted HTTP status code or codes; when absent the status check does not run.",
        [200],
        1,
        "text",
        default=None,
    )
    fields: list[FieldCheck] = expect_field(
        "Fields",
        "Assertions about values inside the response body, which holds data and errors.",
        [[{"path": "data.rooms", "min_length": 1}]],
        2,
        default_factory=list,
    )
    no_errors: bool = expect_field(
        "No errors",
        "True fails the step when the response carries a non-empty errors member.",
        [True],
        3,
        "toggle",
        default=True,
    )
    error_contains: list[str] = expect_field(
        "Error contains",
        "Texts the error messages must contain together, ignoring case; needs no_errors false.",
        [["not authorized"]],
        4,
        "chips",
        default_factory=list,
    )
    latency: HttpLatencyExpect | None = expect_field(
        "Latency", "Upper bound on the response time.", [{"max_ms": 2000}], 5, default=None
    )
    internal_ids: bool = expect_field(
        "Internal ids",
        "True checks that the data shows no internal identifiers.",
        [True],
        6,
        "toggle",
        default=True,
    )
    free_text: str | None = expect_field(
        "Free text",
        "What the response should show, in words, kept for model grading in a later stage.",
        ["A page of rooms"],
        7,
        "textarea",
        default=None,
        max_length=4000,
    )

    @model_validator(mode="after")
    def error_expectations_agree(self) -> Self:
        if self.error_contains and self.no_errors:
            raise to_validation_error(
                "GraphqlExpect",
                [
                    ManifestProblem(
                        code="graphql_errors_expected",
                        message="error_contains expects errors, so no_errors must be false",
                        loc=("no_errors",),
                    )
                ],
            )
        return self


class GraphqlStep(StepBase):
    model_config = section_config(
        "GraphQL step",
        "One query or mutation sent to a graphql interface and what the response must look like. "
        "Subscriptions are not supported.",
        "forbid",
    )

    adapter: Literal["graphql"] = step_field("Adapter", "Step kind.", ["graphql"], 3, "select")
    operation_name: str | None = step_field(
        "Operation name",
        "Operation to run when the document holds several.",
        ["OpenIssues"],
        4,
        default=None,
        pattern=GRAPHQL_NAME_PATTERN,
    )
    query: str = step_field(
        "Query",
        "The GraphQL document; secrets are ${NAME} placeholders.",
        ["query OpenIssues { issues(status: OPEN) { id title } }"],
        5,
        "textarea",
        min_length=1,
        max_length=MAX_GRAPHQL_DOCUMENT_CHARS,
    )
    variables: dict[str, JsonValue] = step_field(
        "Variables",
        "Variables of the operation.",
        [{"room": "20003"}],
        6,
        "yaml",
        default_factory=dict,
    )
    expect: GraphqlExpect = step_field(
        "Expect",
        "What the response must look like.",
        [{"status": 200}],
        7,
        "yaml",
        default_factory=GraphqlExpect,
    )


ScenarioStep = Annotated[
    HttpStep | SseStep | BrowserStep | WebsocketStep | GraphqlStep,
    Field(discriminator="adapter"),
]


class ScenarioDoc(BaseModel):
    model_config = section_config(
        "Tessa scenario",
        "One scripted test of a feature, run by Tessa as one role on one interface: an "
        "ordered list of steps, each with the expectations Tessa checks in code.",
        "forbid",
    )

    schema_version: Literal[1] = header_field(
        "Schema version", "Version of this document format.", [1], 1, "number"
    )
    id: str | None = header_field(
        "Id",
        "Stable key of an authored scenario, kept across edits and re-imports.",
        ["smart-log-open-issues"],
        2,
        default=None,
        pattern=SLUG_PATTERN,
    )
    title: str = header_field(
        "Title",
        "Name shown in the library and the run.",
        ["Staff lists open maintenance issues"],
        3,
        min_length=1,
        max_length=200,
    )
    feature_id: str | None = header_field(
        "Feature id",
        "Manifest feature the scenario tests; absent for synthetic scenarios.",
        ["smart_log.read.open_maintenance"],
        4,
        default=None,
        pattern=SLUG_PATTERN,
    )
    family: str = header_field(
        "Family",
        "Group the scenario counts under, for pass rates; a slug.",
        ["smart-log"],
        5,
        pattern=SLUG_PATTERN,
    )
    role: str = header_field(
        "Role", "Manifest role id the scenario runs as.", ["staff"], 6, pattern=SLUG_PATTERN
    )
    interface_id: str = header_field(
        "Interface id",
        "Manifest interface id the scenario runs against.",
        ["chat_sse"],
        7,
        pattern=SLUG_PATTERN,
    )
    timeout_seconds: int | None = header_field(
        "Timeout",
        "Longest the scenario may take in seconds; absent uses the worker default.",
        [120],
        8,
        "number",
        default=None,
        ge=1,
        le=3600,
    )
    cell: CellRef | None = header_field(
        "Cell",
        "The coverage cell of the scenario; when given it must equal role and interface_id.",
        [{"role": "staff", "interface_id": "chat_sse"}],
        9,
        "yaml",
        default=None,
    )
    authored_from: UUID | None = header_field(
        "Authored from",
        "Id of the Author prompt issue that produced the scenario.",
        ["0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11"],
        10,
        default=None,
    )
    synthetic: bool = header_field(
        "Synthetic",
        "True for scenarios Tessa generates itself, hidden from the library by default.",
        [False],
        11,
        "toggle",
        default=False,
    )
    steps: list[ScenarioStep] = header_field(
        "Steps",
        "Ordered steps; each runs after the previous one.",
        [[{"adapter": "http", "request": {"method": "GET", "path": "/api/rooms"}}]],
        12,
        "yaml",
        min_length=1,
        max_length=200,
    )

    @model_validator(mode="after")
    def cell_matches_the_header(self) -> Self:
        cell = self.cell
        if cell is not None and (cell.role != self.role or cell.interface_id != self.interface_id):
            raise to_validation_error(
                "ScenarioDoc",
                [
                    ManifestProblem(
                        code="cell_mismatch",
                        message="cell must name the same role and interface_id as the scenario",
                        loc=("cell",),
                    )
                ],
            )
        return self
