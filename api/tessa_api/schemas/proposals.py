from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from tessa_api.schemas.bundle import SLUG_PATTERN, TARGET_TOKEN_PATTERN, SourceSection
from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import (
    Confidence,
    Depth,
    ProposalItemChoice,
    ProposalItemStatus,
    ProposalKind,
    ProposalNeed,
    ProposalOrigin,
    ProposalReason,
    ProposalRisk,
)

PROPOSAL_SCHEMA_VERSION = 1
PROPOSAL_FILE = "proposal.yaml"
PROPOSAL_SCHEMA_URL_PATTERN = r"^https?://[^\s/]+(/\S*)?/schemas/proposal\.v1\.json$"
PROPOSAL_KEY_PATTERN = r"^[a-z0-9][a-z0-9_.-]{2,79}$"
PROPOSAL_MAX_ITEMS = 200
PROPOSAL_MAX_YAML_BYTES = 256 * 1024
PROPOSAL_NOTE_MAX_LENGTH = 300

Slug = Annotated[str, Field(pattern=SLUG_PATTERN)]


def strict_config(title: str, description: str) -> ConfigDict:
    return ConfigDict(extra="forbid", title=title, json_schema_extra={"description": description})


class ProposalItemReason(BaseModel):
    model_config = strict_config(
        "Reason", "One reason the area deserves a test, from a closed list of codes."
    )

    code: ProposalReason = Field(description="why the area is worth testing")
    note: str | None = Field(
        default=None,
        max_length=PROPOSAL_NOTE_MAX_LENGTH,
        description="what in the repository shows it, for example a file, a commit or a count",
    )


class ProposalEstimate(BaseModel):
    model_config = strict_config("Estimate", "Rough size of the tests the item asks for.")

    scenarios: int = Field(ge=1, le=50, description="scenarios the item would add")
    minutes: int = Field(ge=1, le=600, description="minutes one run of those scenarios takes")


class ProposalItemDoc(BaseModel):
    model_config = strict_config(
        "Proposal item",
        "One thing worth testing: where it lives, how to test it, how risky it is and why.",
    )

    key: str = Field(
        pattern=PROPOSAL_KEY_PATTERN,
        description="stable slug of the item; a later proposal that keeps the key keeps the "
        "ticks and notes the team made on it",
    )
    title: str = Field(min_length=1, max_length=120, description="one line a person understands")
    area: str = Field(min_length=1, max_length=120, description="catalog area the item belongs to")
    feature_ids: list[Slug] = Field(
        min_length=1,
        max_length=20,
        description="ids of manifest features the item covers; an id that is not in the latest "
        "bundle lowers the confidence of the item",
    )
    interface_id: Slug | None = Field(
        default=None,
        description="manifest interface the item targets; absent means every interface of the "
        "features",
    )
    kind: ProposalKind = Field(description="how the item would be tested")
    risk: ProposalRisk = Field(description="how much a defect here would hurt")
    reasons: list[ProposalItemReason] = Field(
        min_length=1, max_length=6, description="why it ranks where it does"
    )
    needs: list[ProposalNeed] = Field(
        default_factory=list,
        max_length=6,
        description="what the tests need before they can run",
    )
    depth: Depth = Field(description="depth a run of the item should use")
    estimate: ProposalEstimate | None = None
    confidence: Confidence = Field(description="how sure the proposal is about the item")
    evidence: str | None = Field(
        default=None,
        max_length=500,
        description="where in the code the reasons come from, as files, symbols or commits",
    )

    @field_validator("reasons")
    @classmethod
    def reject_repeated_reasons(cls, value: list[ProposalItemReason]) -> list[ProposalItemReason]:
        codes = [reason.code for reason in value]
        if len(set(codes)) != len(codes):
            raise ValueError("each reason code appears at most once")
        return value

    @field_validator("needs")
    @classmethod
    def reject_repeated_needs(cls, value: list[ProposalNeed]) -> list[ProposalNeed]:
        if len(set(value)) != len(value):
            raise ValueError("each need appears at most once")
        return value


class ProposalDoc(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        serialize_by_alias=True,
        title="Tessa test proposal",
        json_schema_extra={
            "description": "The tessa/proposal.yaml file: the areas of an app worth testing, "
            "ranked by risk, with the reasons and what each test needs. Tessa shows it to "
            "the team, which ticks the items to author. Unknown keys are errors. Never write a "
            "secret."
        },
    )

    schema_url: str = Field(
        alias="schema",
        pattern=PROPOSAL_SCHEMA_URL_PATTERN,
        description="URL of this schema; Tessa fills it into the Propose prompt",
        examples=["http://localhost:8000/schemas/proposal.v1.json"],
    )
    target_token: str = Field(
        pattern=TARGET_TOKEN_PATTERN,
        description="routing token of the target the proposal is for",
        examples=["tgt_abcdefghijklmnopqrstuv"],
    )
    generated_at: Timestamp | None = Field(
        default=None, description="when the proposal was written, with a UTC offset"
    )
    source: SourceSection | None = Field(
        default=None, description="commit of the repository the proposal describes"
    )
    authored_from: UUID | None = Field(
        default=None, description="id of the Propose prompt issue the proposal answers"
    )
    items: list[ProposalItemDoc] = Field(
        min_length=1, max_length=PROPOSAL_MAX_ITEMS, description="the items, riskiest first"
    )


class ProposalItem(BaseModel):
    id: UUID
    key: str
    title: str
    area: str
    feature_ids: list[str]
    interface_id: str | None
    kind: ProposalKind
    risk: ProposalRisk
    reasons: list[ProposalItemReason]
    needs: list[ProposalNeed]
    depth: Depth
    estimate: ProposalEstimate | None
    confidence: Confidence
    evidence: str | None
    status: ProposalItemStatus = Field(
        description="proposed, selected or declined by people; authored once a scenario file "
        "answered an Author prompt for the item; covered when every cell it maps to is covered"
    )
    note: str | None = Field(description="the note a person left when they ticked or declined")
    selected_by: UUID | None
    selected_at: Timestamp | None
    cell_ids: list[UUID] = Field(
        description="cells of the coverage baseline plan of the latest valid bundle that the "
        "item maps to, computed when the proposal is read"
    )
    scenario_ids: list[UUID] = Field(description="scenarios authored for the item")


class Proposal(BaseModel):
    id: UUID
    target_id: UUID
    bundle_id: UUID | None
    commit_sha: str | None
    branch: str | None
    generated_at: Timestamp
    source: ProposalOrigin
    created_by: UUID
    created_at: Timestamp
    stale: bool = Field(
        description="true when the target has a newer valid bundle than the one the proposal "
        "was written against"
    )
    items: list[ProposalItem]


class ProposalPut(BaseModel):
    yaml: str = Field(
        min_length=1,
        max_length=PROPOSAL_MAX_YAML_BYTES,
        description="content of tessa/proposal.yaml, validated like the file of a bundle",
    )


class ProposalItemUpdate(BaseModel):
    status: ProposalItemChoice = Field(
        description="proposed, selected or declined; authored and covered are set by Tessa"
    )
    note: str | None = Field(
        default=None,
        max_length=PROPOSAL_NOTE_MAX_LENGTH,
        description="why the item was ticked or declined; absent keeps the current note",
    )


class ProposalPlanCreate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    item_ids: list[UUID] | None = Field(
        default=None,
        min_length=1,
        max_length=PROPOSAL_MAX_ITEMS,
        description="items to plan; absent plans every selected item of the current proposal",
    )
