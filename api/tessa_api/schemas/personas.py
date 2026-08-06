from typing import Annotated, Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from tessa_api.schemas.enums import PersonaTone, TraitLevel

PERSONA_SCHEMA_VERSION = 1
PERSONA_NAME_MAX_LENGTH = 120
PERSONA_DESCRIPTION_MAX_LENGTH = 1000

PersonaName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=PERSONA_NAME_MAX_LENGTH),
]
PersonaDescription = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=PERSONA_DESCRIPTION_MAX_LENGTH
    ),
]


def trait_field(label: str, description: str, order: int, widget: str = "select") -> Any:
    return Field(
        default=None,
        title=label,
        description=description,
        json_schema_extra={
            "x-ui": {"label": label, "group": "How they behave", "order": order, "widget": widget}
        },
    )


class PersonaTraits(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="Persona traits",
        json_schema_extra={"description": "Closed set of traits the simulated user follows."},
    )

    patience: TraitLevel | None = trait_field(
        "Patience", "How long the persona tolerates slow or unhelpful answers.", 1
    )
    verbosity: TraitLevel | None = trait_field(
        "Verbosity", "How much the persona writes in each turn.", 2
    )
    tech_savviness: TraitLevel | None = trait_field(
        "Tech savviness", "How comfortable the persona is with apps and chat assistants.", 3
    )
    assertiveness: TraitLevel | None = trait_field(
        "Assertiveness", "How hard the persona pushes back and repeats a request.", 4
    )
    tone: PersonaTone | None = trait_field("Tone", "The register the persona writes in.", 5)


class PersonaFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        title="Persona",
        json_schema_extra={"description": "A simulated user: who they are and how they talk."},
    )

    name: PersonaName = Field(
        title="Name",
        description="Short name that tells personas apart in lists; unique per target.",
        examples=["Impatient front desk guest"],
        json_schema_extra={"x-ui": {"label": "Name", "group": "Who", "order": 1, "widget": "text"}},
    )
    description: PersonaDescription = Field(
        title="Description",
        description="Background the simulator plays: who they are and what they want.",
        examples=["A guest in a hurry who writes short messages and expects instant answers."],
        json_schema_extra={
            "x-ui": {"label": "Description", "group": "Who", "order": 2, "widget": "textarea"}
        },
    )
    traits: PersonaTraits = Field(
        title="Traits",
        description="Closed set of traits; unset traits leave the simulator free to choose.",
    )


class PersonaCreate(PersonaFields):
    model_config = ConfigDict(extra="forbid", title="PersonaCreate")

    target_id: UUID


class PersonaUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: PersonaName | None = None
    description: PersonaDescription | None = None
    traits: PersonaTraits | None = None


class Persona(BaseModel):
    id: UUID
    target_id: UUID
    name: str
    description: str
    traits: PersonaTraits
    created_by: UUID


class PersonaPage(BaseModel):
    items: list[Persona]
    next_cursor: str | None
    total: int | None
