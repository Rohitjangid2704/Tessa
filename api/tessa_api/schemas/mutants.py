from typing import Annotated, Self
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import MutantStatus, MutationOutcome
from tessa_api.schemas.goals import ui_hints

MUTANT_SCHEMA_VERSION = 1
MUTANT_NAME_MAX_LENGTH = 120
MUTANT_BRANCH_MAX_LENGTH = 200
MUTANT_DESCRIPTION_MAX_LENGTH = 2000
MUTANT_BASE_URL_MAX_LENGTH = 500
MUTANT_BASE_URL_PATTERN = r"^https?://\S+$"
MUTANT_MAX_CATCHERS = 20
MUTANT_INVARIANT_ID_MAX_LENGTH = 80
DEPLOYED_MARKER_PATH_MAX_LENGTH = 200
DEPLOYED_MARKER_PATH_PATTERN = r"^/([^/\s\\][^\s\\]*)?$"
DEPLOYED_MARKER_TEXT_MAX_LENGTH = 200
MUTANTS_SIDECAR_PATH = "tessa/mutants.yaml"
MUTANTS_SIDECAR_MAX_ENTRIES = 100
MUTANT_REQUIRED_UPDATE_FIELDS = ("name", "branch", "description", "expected_catchers", "status")

MutantName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MUTANT_NAME_MAX_LENGTH),
]
MutantBranch = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MUTANT_BRANCH_MAX_LENGTH),
]
MutantDescription = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=MUTANT_DESCRIPTION_MAX_LENGTH
    ),
]
MutantBaseUrl = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=MUTANT_BASE_URL_MAX_LENGTH,
        pattern=MUTANT_BASE_URL_PATTERN,
    ),
]
InvariantIdText = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=MUTANT_INVARIANT_ID_MAX_LENGTH
    ),
]
MarkerText = Annotated[
    str, StringConstraints(min_length=1, max_length=DEPLOYED_MARKER_TEXT_MAX_LENGTH)
]


def require_unique_catchers(value: list[str]) -> list[str]:
    if len(set(value)) != len(value):
        raise ValueError("expected_catchers must not repeat an invariant")
    return value


class DeployedMarker(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="Deployed marker",
        json_schema_extra={
            "description": "A QA-only route that proves which mutant is deployed: a mutation run "
            "reads it before it starts and marks every outcome errored, never survived, when "
            "the text is missing."
        },
    )

    path: str = Field(
        min_length=1,
        max_length=DEPLOYED_MARKER_PATH_MAX_LENGTH,
        pattern=DEPLOYED_MARKER_PATH_PATTERN,
        title="Path",
        description="Path on the mutant's base URL, with a single leading slash.",
        examples=["/__qa/mutant"],
        json_schema_extra=ui_hints("Path", "Deployed marker", 1, "text"),
    )
    expected_text: MarkerText = Field(
        title="Expected text",
        description="Text the response body must contain when this mutant is the deployed build.",
        examples=["skip-tenant-filter-on-issue-list"],
        json_schema_extra=ui_hints("Expected text", "Deployed marker", 2, "text"),
    )


class MutantFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="Mutant",
        json_schema_extra={
            "description": "One known bug: a branch of the app with a single deliberate defect, "
            "and the invariants that should catch it."
        },
    )

    name: MutantName = Field(
        title="Name",
        description="A short slug that names the bug; unique per target.",
        examples=["skip-tenant-filter-on-issue-list"],
        json_schema_extra=ui_hints("Name", "The bug", 10, "text"),
    )
    branch: MutantBranch = Field(
        title="Branch",
        description="The git branch that carries the defect.",
        examples=["tessa/mutant/skip-tenant-filter-on-issue-list"],
        json_schema_extra=ui_hints("Branch", "The bug", 20, "text"),
    )
    description: MutantDescription = Field(
        title="Description",
        description="What the branch breaks, in a sentence or two.",
        examples=["The issue list query no longer filters by tenant."],
        json_schema_extra=ui_hints("What it breaks", "The bug", 30, "textarea"),
    )
    expected_catchers: list[InvariantIdText] = Field(
        min_length=1,
        max_length=MUTANT_MAX_CATCHERS,
        title="Expected catchers",
        description="The invariants that should fail when this bug is present. A mutant that "
        "none of them catches survives.",
        examples=[["tenant_isolation", "count_consistency"]],
        json_schema_extra={
            **ui_hints("Invariants that should catch it", "What should catch it", 40, "invariants"),
            "uniqueItems": True,
        },
    )
    base_url: MutantBaseUrl | None = Field(
        default=None,
        title="Base URL",
        description="Where the branch is deployed on QA. Required before the mutant can be "
        "marked deployed; a mutation run can also override it.",
        examples=["https://gracie-mutant-1.qa.example.test"],
        json_schema_extra=ui_hints("Deployed at", "Where it runs", 50, "text"),
    )
    deployed_marker: DeployedMarker | None = Field(
        default=None,
        title="Deployed marker",
        description="Optional QA-only route that shows which build is deployed.",
        json_schema_extra=ui_hints("Deployed marker", "Where it runs", 60, "json"),
    )

    @field_validator("expected_catchers")
    @classmethod
    def catchers_are_unique(cls, value: list[str]) -> list[str]:
        return require_unique_catchers(value)


class MutantCreate(MutantFields):
    model_config = ConfigDict(extra="forbid", title="MutantCreate")

    target_id: UUID


class MutantUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: MutantName | None = None
    branch: MutantBranch | None = None
    description: MutantDescription | None = None
    expected_catchers: list[InvariantIdText] | None = Field(
        default=None, min_length=1, max_length=MUTANT_MAX_CATCHERS
    )
    base_url: MutantBaseUrl | None = Field(
        default=None, description="an explicit null clears the base URL"
    )
    deployed_marker: DeployedMarker | None = Field(
        default=None, description="an explicit null clears the marker"
    )
    status: MutantStatus | None = Field(
        default=None, description="registered, deployed or retired; retired mutants are not run"
    )

    @field_validator("expected_catchers")
    @classmethod
    def catchers_are_unique(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else require_unique_catchers(value)

    @model_validator(mode="after")
    def required_fields_are_not_null(self) -> Self:
        nulled = [
            name
            for name in MUTANT_REQUIRED_UPDATE_FIELDS
            if name in self.model_fields_set and getattr(self, name) is None
        ]
        if nulled:
            raise ValueError(f"{', '.join(nulled)} cannot be null")
        return self


class Mutant(BaseModel):
    id: UUID
    target_id: UUID
    name: str
    branch: str
    description: str
    expected_catchers: list[str]
    base_url: str | None
    deployed_marker: DeployedMarker | None
    status: MutantStatus
    last_outcome: MutationOutcome | None = Field(
        description="outcome of the latest mutation run; killed when it caught the bug"
    )
    created_at: Timestamp


class MutantPage(BaseModel):
    items: list[Mutant]
    next_cursor: str | None
    total: int | None
