import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op
from tessa_api.ids import new_id

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PROMPTS_DIRECTORY = Path(__file__).resolve().parents[2] / "prompts"
TEMPLATE_NAME = "discovery"
PREVIOUS_VERSION = 1


@dataclass(frozen=True)
class ShippedTemplate:
    name: str
    version: int
    sha256: str
    variables: tuple[str, ...]

    @property
    def path(self) -> Path:
        return PROMPTS_DIRECTORY / f"{self.name}.v{self.version}.md"


DISCOVERY_V2 = ShippedTemplate(
    name=TEMPLATE_NAME,
    version=2,
    sha256="97bbad6a0a5bd0b255392ea9e73890f9032398c61afe9228863a25cd31975d37",
    variables=("SCHEMA_URL", "TARGET_TOKEN", "APP_KIND_HINTS"),
)

prompt_templates = sa.table(
    "prompt_templates",
    sa.column("id", sa.Uuid()),
    sa.column("name", sa.Text()),
    sa.column("version", sa.Integer()),
    sa.column("text", sa.Text()),
    sa.column("variables", postgresql.JSONB(astext_type=sa.Text())),
    sa.column("is_current", sa.Boolean()),
)


def read_shipped_text(template: ShippedTemplate) -> str:
    text = template.path.read_bytes().decode("utf-8").replace("\r\n", "\n")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != template.sha256:
        raise RuntimeError(
            f"{template.path.name} changed after it shipped: restore it, or add a new version "
            "of the template together with a migration that flips is_current"
        )
    return text


def set_current(version: int, is_current: bool) -> None:
    op.execute(
        prompt_templates.update()
        .where(
            sa.and_(
                prompt_templates.c.name == TEMPLATE_NAME,
                prompt_templates.c.version == version,
            )
        )
        .values(is_current=is_current)
    )


def upgrade() -> None:
    set_current(PREVIOUS_VERSION, False)
    op.bulk_insert(
        prompt_templates,
        [
            {
                "id": new_id(),
                "name": DISCOVERY_V2.name,
                "version": DISCOVERY_V2.version,
                "text": read_shipped_text(DISCOVERY_V2),
                "variables": list(DISCOVERY_V2.variables),
                "is_current": True,
            }
        ],
    )


def downgrade() -> None:
    op.execute(
        prompt_templates.delete().where(
            sa.and_(
                prompt_templates.c.name == DISCOVERY_V2.name,
                prompt_templates.c.version == DISCOVERY_V2.version,
            )
        )
    )
    set_current(PREVIOUS_VERSION, True)
