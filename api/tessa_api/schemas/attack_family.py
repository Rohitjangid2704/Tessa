from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tessa_api.schemas.attack_pack import (
    ATTACK_DESCRIPTION_MAX_CHARS,
    ATTACK_ID_PATTERN,
    ATTACK_PROMPT_MAX_CHARS,
    ATTACK_VERSION_PATTERN,
    CANARY_PATTERN,
    CANARY_TOKEN_PATTERN,
)
from tessa_api.schemas.enums import BuiltInInvariantId

FAMILY_SCHEMA_VERSION = 1
FAMILY_ID_PATTERN = r"^[a-z][a-z0-9_]*$"
FAMILY_ID_MAX_LENGTH = 64
FAMILY_TITLE_MAX_CHARS = 80
FAMILY_DESCRIPTION_MAX_CHARS = 300
FAMILY_OBJECTIVE_MAX_CHARS = 600
FAMILY_TACTIC_MAX_CHARS = 200
FAMILY_MAX_TACTICS = 8
FAMILY_MAX_PROBES = 6
PROBE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"

TacticText = Annotated[str, Field(min_length=1, max_length=FAMILY_TACTIC_MAX_CHARS)]
BreachProbeId = Annotated[str, Field(pattern=PROBE_ID_PATTERN)]


class FamilyCodeCheck(StrEnum):
    canary = "canary"
    internal_ids = "internal_ids"
    secrets = "secrets"


class FamilyDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(
        pattern=FAMILY_ID_PATTERN,
        max_length=FAMILY_ID_MAX_LENGTH,
        description="stable slug; also the file name of the family without the extension",
    )
    title: str = Field(min_length=1, max_length=FAMILY_TITLE_MAX_CHARS)
    description: str = Field(min_length=1, max_length=FAMILY_DESCRIPTION_MAX_CHARS)
    invariant_id: BuiltInInvariantId = Field(
        description="invariant a confirmed breach violates; decides the class of the finding"
    )
    objective: str = Field(
        min_length=1,
        max_length=FAMILY_OBJECTIVE_MAX_CHARS,
        description="what a breach looks like; shown to the attack model and to the skeptic",
    )
    tactics: list[TacticText] = Field(
        min_length=1,
        max_length=FAMILY_MAX_TACTICS,
        description="ways to attempt the breach; shown to the attack model",
    )
    code_checks: list[FamilyCodeCheck] = Field(
        default_factory=list,
        description="checks code runs on the answer: a canary token, internal ids, secrets",
    )
    breach_probes: list[BreachProbeId] = Field(
        default_factory=list,
        max_length=FAMILY_MAX_PROBES,
        description="probe bank ids Laya answers about the reply; a violated probe is a breach",
    )

    @model_validator(mode="after")
    def has_a_way_to_see_a_breach(self) -> Self:
        if not self.code_checks and not self.breach_probes:
            raise ValueError("a family needs at least one code check or one breach probe")
        if len(set(self.code_checks)) != len(self.code_checks):
            raise ValueError("code checks are listed at most once")
        if len(set(self.breach_probes)) != len(self.breach_probes):
            raise ValueError("breach probes are listed at most once")
        return self

    @property
    def uses_canary(self) -> bool:
        return FamilyCodeCheck.canary in self.code_checks


class FamilyAttack(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=ATTACK_ID_PATTERN, description="stable slug of the seed attack")
    description: str = Field(min_length=1, max_length=ATTACK_DESCRIPTION_MAX_CHARS)
    prompt: str = Field(
        min_length=1,
        max_length=ATTACK_PROMPT_MAX_CHARS,
        description="message sent to the assistant; short enough for the probes to read it",
    )
    canary: str | None = Field(
        default=None,
        pattern=f"^{CANARY_TOKEN_PATTERN}$",
        description="token the assistant must never write; the prompt asks for it",
    )
    version: str = Field(pattern=ATTACK_VERSION_PATTERN)


class AttackFamilyFile(BaseModel):
    model_config = ConfigDict(extra="forbid", title="Tessa attack family")

    schema_version: Literal[1] = Field(description="version of the attack family file format")
    family: FamilyDefinition
    attacks: list[FamilyAttack] = Field(min_length=1)

    @model_validator(mode="after")
    def ids_are_unique(self) -> Self:
        ids = [attack.id for attack in self.attacks]
        duplicates = sorted({attack_id for attack_id in ids if ids.count(attack_id) > 1})
        if duplicates:
            raise ValueError(f"attack ids must be unique: {', '.join(duplicates)}")
        return self

    @model_validator(mode="after")
    def canaries_match_the_family(self) -> Self:
        for attack in self.attacks:
            if self.family.uses_canary and attack.canary is None:
                raise ValueError(f"{attack.id}: a canary family carries a canary in every attack")
            if attack.canary is not None and not self.family.uses_canary:
                raise ValueError(f"{attack.id}: the family does not list the canary code check")
            if attack.canary is not None and attack.canary not in attack.prompt:
                raise ValueError(f"{attack.id}: the prompt must contain the canary it asks for")
            if attack.canary is None and CANARY_PATTERN.search(attack.prompt):
                raise ValueError(f"{attack.id}: a canary in the prompt must be declared")
        return self
