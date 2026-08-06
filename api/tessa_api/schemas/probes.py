from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tessa_api.schemas.common import Probability
from tessa_api.schemas.enums import (
    AdapterKind,
    FeatureKind,
    InvariantPack,
    ProbeAnswerType,
    ProbeEngine,
    ProbeInputField,
    ProbeSource,
    ProbeStatus,
)

PROBE_SCHEMA_VERSION = 1
PROBE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
PROBE_VERSION_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
PROBE_QUESTION_MAX_CHARS = 400
PROBE_INPUT_MAX_CHARS_CEILING = 2000
PROBE_CHOICE_MAX_CHARS = 60

BankPack = Literal[InvariantPack.generic, InvariantPack.llm_app]


class ProbeBankModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProbeAppliesTo(ProbeBankModel):
    feature_kinds: list[FeatureKind] = Field(
        default_factory=list, description="feature kinds the probe applies to; empty means all"
    )
    adapters: list[AdapterKind] = Field(
        default_factory=list, description="adapters the probe applies to; empty means all"
    )


class ProbeInputFieldSpec(ProbeBankModel):
    name: ProbeInputField = Field(description="short text field of the step the probe may read")
    max_chars: int = Field(
        ge=1,
        le=PROBE_INPUT_MAX_CHARS_CEILING,
        description="longer text is never truncated: the step goes to the judge as too_long",
    )


class ProbeInput(ProbeBankModel):
    fields: list[ProbeInputFieldSpec] = Field(
        min_length=1, description="fields shown to Laya, from the allow-list"
    )

    @model_validator(mode="after")
    def fields_are_listed_once(self) -> Self:
        names = [spec.name for spec in self.fields]
        if len(names) != len(set(names)):
            raise ValueError("each input field is listed at most once")
        return self


class ProbeDefinition(ProbeBankModel):
    id: str = Field(pattern=PROBE_ID_PATTERN, description="stable slug of the probe")
    pack: BankPack = Field(description="pack the probe belongs to; target probes come from bundles")
    question: str = Field(
        min_length=1,
        max_length=PROBE_QUESTION_MAX_CHARS,
        description="typed question about a short text, never about numbers, dates or long text",
    )
    answer_type: ProbeAnswerType = Field(description="yes_no or choice, nothing else")
    choices: list[Annotated[str, Field(min_length=1, max_length=PROBE_CHOICE_MAX_CHARS)]] = Field(
        default_factory=list, description="answers of a choice question; empty for yes_no"
    )
    applies_to: ProbeAppliesTo = Field(default_factory=ProbeAppliesTo)
    input: ProbeInput
    threshold: Probability | None = Field(
        default=None, description="confidence needed to decide; the global threshold when absent"
    )
    invariant_id: str = Field(
        pattern=PROBE_ID_PATTERN, description="invariant whose violation the probe detects"
    )
    version: str = Field(
        pattern=PROBE_VERSION_PATTERN, description="version label, bumped when the question changes"
    )

    @model_validator(mode="after")
    def choices_match_the_answer_type(self) -> Self:
        if self.answer_type is ProbeAnswerType.yes_no and self.choices:
            raise ValueError("a yes_no probe has no choices")
        if self.answer_type is ProbeAnswerType.choice:
            if len(self.choices) < 2:
                raise ValueError("a choice probe needs at least two choices")
            if len(self.choices) != len(set(self.choices)):
                raise ValueError("choices must be distinct")
        return self


class ProbeBankFile(ProbeBankModel):
    model_config = ConfigDict(extra="forbid", title="Tessa probe bank")

    schema_version: Literal[1] = Field(description="version of the probe file format")
    probes: list[ProbeDefinition] = Field(min_length=1)

    @model_validator(mode="after")
    def ids_are_unique(self) -> Self:
        ids = [probe.id for probe in self.probes]
        duplicates = sorted({probe_id for probe_id in ids if ids.count(probe_id) > 1})
        if duplicates:
            raise ValueError(f"probe ids must be unique: {', '.join(duplicates)}")
        return self


class Probe(BaseModel):
    id: str
    pack: InvariantPack
    question: str
    answer_type: ProbeAnswerType
    threshold: Probability = Field(description="effective confidence threshold of the probe")
    version: str
    source: ProbeSource = Field(description="where the probe comes from")


class ProbePage(BaseModel):
    items: list[Probe]
    next_cursor: str | None
    total: int | None


class ProbeResult(BaseModel):
    id: UUID
    probe_id: str
    pack: InvariantPack
    question: str
    answer: str | None = Field(description="answer Laya chose; null when the call failed")
    status: ProbeStatus = Field(description="error is never a pass; uncertain escalates")
    confidence: Probability = Field(description="confidence of the answer; 0 when status is error")
    threshold: Probability = Field(description="threshold that applied to this result")
    latency_ms: int = Field(ge=0)
    probe_bank_version: str = Field(description="version of the probe bank that was used")
    engine: ProbeEngine = Field(description="always laya before Stage 10")
