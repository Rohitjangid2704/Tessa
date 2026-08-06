from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, RootModel, model_validator

from tessa_api.schemas.bundle import COMMIT_PATTERN
from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import PromptTemplateName

AUTHOR_PROMPT_MAX_CELLS = 50
MUTANTS_PROMPT_MAX_INVARIANTS = 50
PROPOSE_PROMPT_MAX_FOCUS = 20


class PromptTemplate(BaseModel):
    name: PromptTemplateName
    version: int
    text: str
    variables: list[str] = Field(description="placeholder names the template substitutes")
    created_at: Timestamp


class PromptTemplatePage(BaseModel):
    items: list[PromptTemplate]
    next_cursor: str | None
    total: int | None


class DiscoveryPromptParams(BaseModel):
    template_name: Literal["discovery"]
    hint_ids: list[str] = Field(default_factory=list, max_length=50)
    template_version: int | None = Field(
        default=None,
        ge=1,
        description="Discovery template version to render, for example 1 to keep the first "
        "version; absent renders the current version",
    )


class FixupPromptParams(BaseModel):
    template_name: Literal["fixup"]
    bundle_id: UUID


class ExplainPromptParams(BaseModel):
    template_name: Literal["explain"]
    finding_id: UUID


class AuthorPromptParams(BaseModel):
    template_name: Literal["author"]
    cell_ids: list[UUID] | None = Field(
        default=None,
        min_length=1,
        max_length=AUTHOR_PROMPT_MAX_CELLS,
        description="coverage cells to author; send exactly one of cell_ids and proposal_item_ids",
    )
    proposal_item_ids: list[UUID] | None = Field(
        default=None,
        min_length=1,
        max_length=AUTHOR_PROMPT_MAX_CELLS,
        description="items of the current proposal to author; the prompt covers the cells they "
        "map to and says why each item matters",
    )

    @model_validator(mode="after")
    def names_exactly_one_source(self) -> Self:
        if (self.cell_ids is None) == (self.proposal_item_ids is None):
            raise ValueError("send exactly one of cell_ids and proposal_item_ids")
        return self


class MutantsPromptParams(BaseModel):
    template_name: Literal["mutants"]
    invariant_ids: list[str] = Field(
        min_length=1,
        max_length=MUTANTS_PROMPT_MAX_INVARIANTS,
        description="invariants the mutants should be designed to trip, built in or of the bundle",
    )


class HooksPromptParams(BaseModel):
    template_name: Literal["hooks"]
    bundle_id: UUID = Field(description="bundle whose test_hooks.missing the prompt asks for")


class ProposePromptParams(BaseModel):
    template_name: Literal["propose"]
    focus: list[str] = Field(
        default_factory=list,
        max_length=PROPOSE_PROMPT_MAX_FOCUS,
        description="catalog areas to concentrate on; empty looks at every area",
    )
    since_commit: str | None = Field(
        default=None,
        pattern=COMMIT_PATTERN,
        description="rank by what changed after this commit, as 7 to 40 hex digits; absent "
        "looks at the whole history that matters",
    )


PromptIssueParams = Annotated[
    DiscoveryPromptParams
    | FixupPromptParams
    | ExplainPromptParams
    | AuthorPromptParams
    | MutantsPromptParams
    | HooksPromptParams
    | ProposePromptParams,
    Field(discriminator="template_name"),
]


class PromptIssueCreate(RootModel[PromptIssueParams]):
    pass


class PromptIssue(BaseModel):
    id: UUID
    target_id: UUID
    template_name: PromptTemplateName
    template_version: int
    target_token: str
    text: str
    params: dict[str, Any]
    issued_by: UUID
    issued_at: Timestamp


class PromptIssuePage(BaseModel):
    items: list[PromptIssue]
    next_cursor: str | None
    total: int | None
