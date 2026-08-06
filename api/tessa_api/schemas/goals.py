from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from tessa_api.schemas.enums import CriterionKind, GoalKind

GOAL_SCHEMA_VERSION = 1
GOAL_TITLE_MAX_LENGTH = 120
GOAL_STATEMENT_MAX_LENGTH = 2000
GOAL_ROLE_MAX_LENGTH = 80
CRITERION_MAX_LENGTH = 500
CRITERIA_MAX_COUNT = 20
DEFAULT_CRITERION_KIND = CriterionKind.judge
CRITERION_PREFIX_SEPARATOR = ":"
CRITERION_KIND_NAMES = "|".join(kind.value for kind in CriterionKind)
CRITERION_PATTERN = rf"^(?!(?:{CRITERION_KIND_NAMES}):\s*$)\S"
CRITERIA_GRAMMAR = (
    "Each entry starts with a typed prefix: db: (an end-state expectation checked by code "
    "against the truth source), tool: (a tool-call expectation checked by code), text: (a "
    "substring or pattern checked by code) or judge: (a natural-language criterion decided by "
    "the judge from the evidence block). An entry without a prefix means judge:. "
    "db: <oracle> [{params}] [row_count=N] [min_rows=N] [max_rows=N] [first_row={...}] "
    "[rows=[{...}]] [retry=SECONDS] runs an approved oracle of the bundle after the session; "
    "without an assertion at least one row is expected. "
    "tool: [not] <tool_name> [{args}] expects the target to have called (or, with not, never "
    "called) that tool during the session. "
    "text: [not] <text> or text: [not] /regex/ looks for the text (case-insensitive) in the "
    "replies of the target; put a text that starts with not in double quotes. "
    "judge: <criterion in plain words> is decided by the judge from the transcript."
)

GoalTitle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=GOAL_TITLE_MAX_LENGTH)
]
GoalStatement = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=GOAL_STATEMENT_MAX_LENGTH),
]
GoalRole = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=GOAL_ROLE_MAX_LENGTH)
]
SuccessCriterion = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=CRITERION_MAX_LENGTH,
        pattern=CRITERION_PATTERN,
    ),
]


def ui_hints(label: str, group: str, order: int, widget: str) -> dict[str, Any]:
    return {"x-ui": {"label": label, "group": group, "order": order, "widget": widget}}


class GoalFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        regex_engine="python-re",
        title="Goal",
        json_schema_extra={
            "description": "What a simulated user or an explorer tries to achieve and how "
            "success is decided."
        },
    )

    title: GoalTitle = Field(
        title="Title",
        description="Short name that tells goals apart in lists.",
        examples=["Report a broken air conditioner"],
        json_schema_extra=ui_hints("Title", "What", 1, "text"),
    )
    kind: GoalKind = Field(
        title="Kind",
        description="reach_state: get the app into a target state; extract_fact: get one "
        "specific fact stated; attempt_forbidden: try an action the role must not be allowed "
        "to do; complete_flow: finish a multi-step flow.",
        examples=["complete_flow"],
        json_schema_extra=ui_hints("Kind of goal", "What", 2, "select"),
    )
    statement: GoalStatement = Field(
        title="Statement",
        description="The goal in the user's own words; the agent works toward it.",
        examples=["My room's air conditioner does not cool. I want it fixed today."],
        json_schema_extra=ui_hints("Statement", "What", 3, "textarea"),
    )
    success_criteria: list[SuccessCriterion] = Field(
        max_length=CRITERIA_MAX_COUNT,
        title="Success criteria",
        description=CRITERIA_GRAMMAR,
        examples=[
            [
                'db: maintenance_requests {"room": "1204"} min_rows=1 retry=5',
                "tool: create_request",
                "text: confirmation number",
                "judge: the assistant promised no specific repair time",
            ]
        ],
        json_schema_extra=ui_hints("Success criteria", "Success", 4, "chips"),
    )
    role: GoalRole | None = Field(
        default=None,
        title="Role",
        description="App role the agent signs in as; empty means it is chosen when a run starts.",
        examples=["guest"],
        json_schema_extra=ui_hints("Role", "Who", 5, "text"),
    )


class GoalCreate(GoalFields):
    model_config = ConfigDict(extra="forbid", regex_engine="python-re", title="GoalCreate")

    target_id: UUID


class GoalUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", regex_engine="python-re")

    title: GoalTitle | None = None
    kind: GoalKind | None = None
    statement: GoalStatement | None = None
    success_criteria: list[SuccessCriterion] | None = Field(
        default=None, max_length=CRITERIA_MAX_COUNT
    )
    role: GoalRole | None = None


class Goal(BaseModel):
    id: UUID
    target_id: UUID
    title: str
    kind: GoalKind
    statement: str
    success_criteria: list[str]
    role: str | None


class GoalPage(BaseModel):
    items: list[Goal]
    next_cursor: str | None
    total: int | None
