from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

from tessa_api.schemas.enums import Tier0Check

ELEMENT_ROLE_MAX_CHARS = 40
ELEMENT_NAME_MAX_CHARS = 200
ACTION_URL_MAX_CHARS = 2000
ACTION_TEXT_MAX_CHARS = 500
CLAIM_MAX_CHARS = 1000
ASSERTION_VALUE_MAX_CHARS = 500
SNAPSHOT_ASSERTION_CHECKS = frozenset(
    {
        Tier0Check.text_contains,
        Tier0Check.text_not_contains,
        Tier0Check.console,
        Tier0Check.dom_state,
    }
)


class ElementRef(BaseModel):
    model_config = ConfigDict(frozen=True)

    role: str = Field(
        min_length=1, max_length=ELEMENT_ROLE_MAX_CHARS, description="ARIA role of the element"
    )
    name: str = Field(
        max_length=ELEMENT_NAME_MAX_CHARS, description="accessible name; empty when it has none"
    )
    index: int = Field(
        default=0,
        ge=0,
        description="position among the elements of one snapshot with the same role and name",
    )


class SnapshotAssertion(BaseModel):
    model_config = ConfigDict(frozen=True)

    check: Tier0Check = Field(
        description="Tier 0 check, one of text_contains, text_not_contains, console, dom_state"
    )
    value: str = Field(
        min_length=1,
        max_length=ASSERTION_VALUE_MAX_CHARS,
        description="text, console message fragment or dom state the check looks for",
    )

    @model_validator(mode="after")
    def check_is_decidable_on_a_snapshot(self) -> Self:
        if self.check not in SNAPSHOT_ASSERTION_CHECKS:
            allowed = ", ".join(sorted(check.value for check in SNAPSHOT_ASSERTION_CHECKS))
            raise ValueError(f"an assertion on a snapshot uses one of: {allowed}")
        return self


class NavigateAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["navigate"]
    url: str = Field(min_length=1, max_length=ACTION_URL_MAX_CHARS)


class ClickAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["click"]
    target: ElementRef


class TypeAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["type"]
    target: ElementRef
    text: str = Field(max_length=ACTION_TEXT_MAX_CHARS)
    submit: bool = Field(default=False, description="press Enter after typing")


class ReadAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["read"]
    target: ElementRef | None = Field(
        default=None, description="element whose text to read; absent reads the whole page"
    )


class FinishAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["finish"]
    claim: str | None = Field(
        default=None,
        max_length=CLAIM_MAX_CHARS,
        description="what the explorer believes it found; null when it found nothing",
    )
    assertion: SnapshotAssertion | None = Field(
        default=None,
        description="typed check that code runs on the original and on every replay snapshot",
    )

    @model_validator(mode="after")
    def claim_carries_a_typed_assertion(self) -> Self:
        if (self.claim is None) != (self.assertion is None):
            raise ValueError("a claim and its typed assertion are sent together or not at all")
        return self


ExploreAction = Annotated[
    NavigateAction | ClickAction | TypeAction | ReadAction | FinishAction,
    Field(discriminator="kind"),
]

explore_action_adapter: TypeAdapter[ExploreAction] = TypeAdapter(ExploreAction)
