import re
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tessa_api.schemas.enums import BuiltInInvariantId

ATTACK_PACK_SCHEMA_VERSION = 1
ATTACK_ID_PATTERN = r"^[a-z][a-z0-9_]*$"
ATTACK_VERSION_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]*$"
CANARY_TOKEN_PATTERN = r"TESSA-CANARY-[A-Z0-9]{6,12}"
CANARY_PATTERN = re.compile(CANARY_TOKEN_PATTERN)
ATTACK_PROMPT_MAX_CHARS = 300
ATTACK_DESCRIPTION_MAX_CHARS = 200

AttackInvariantId = Literal[
    BuiltInInvariantId.refuses_out_of_scope,
    BuiltInInvariantId.injection_resistance,
    BuiltInInvariantId.authority_pressure,
]
CANARY_INVARIANT_IDS = frozenset(
    {BuiltInInvariantId.injection_resistance, BuiltInInvariantId.authority_pressure}
)


class AttackDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=ATTACK_ID_PATTERN, description="stable slug of the attack")
    invariant: AttackInvariantId = Field(description="invariant the attack puts to the test")
    description: str = Field(
        min_length=1,
        max_length=ATTACK_DESCRIPTION_MAX_CHARS,
        description="what the attack tries, in one sentence",
    )
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
    version: str = Field(
        pattern=ATTACK_VERSION_PATTERN, description="version label, bumped when the prompt changes"
    )

    @model_validator(mode="after")
    def canary_matches_the_invariant(self) -> Self:
        needs_canary = self.invariant in CANARY_INVARIANT_IDS
        if needs_canary and self.canary is None:
            raise ValueError(f"{self.invariant.value} attacks carry a canary")
        if self.canary is not None and self.canary not in self.prompt:
            raise ValueError("the prompt must contain the canary it asks for")
        if self.canary is None and CANARY_PATTERN.search(self.prompt):
            raise ValueError("a canary written in the prompt must be declared as canary")
        return self


class AttackPackFile(BaseModel):
    model_config = ConfigDict(extra="forbid", title="Tessa attack pack")

    schema_version: Literal[1] = Field(description="version of the attack pack file format")
    attacks: list[AttackDefinition] = Field(min_length=1)

    @model_validator(mode="after")
    def ids_are_unique(self) -> Self:
        ids = [attack.id for attack in self.attacks]
        duplicates = sorted({attack_id for attack_id in ids if ids.count(attack_id) > 1})
        if duplicates:
            raise ValueError(f"attack ids must be unique: {', '.join(duplicates)}")
        return self
