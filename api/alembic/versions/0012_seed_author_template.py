import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op
from tessa_api.ids import new_id

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PROMPTS_DIRECTORY = Path(__file__).resolve().parents[2] / "prompts"


@dataclass(frozen=True)
class ShippedTemplate:
    name: str
    version: int
    sha256: str
    variables: tuple[str, ...]

    @property
    def path(self) -> Path:
        return PROMPTS_DIRECTORY / f"{self.name}.v{self.version}.md"


SHIPPED_TEMPLATES = (
    ShippedTemplate(
        name="author",
        version=1,
        sha256="71604d938dc3d1afdf19a259173cfe72a112a63e295480ffb2dd5a654e71a32f",
        variables=(
            "BUNDLE_VERSION",
            "TARGET_TOKEN",
            "PROMPT_ISSUE_ID",
            "CELL_COUNT",
            "CELLS",
            "SCENARIO_SCHEMA_URL",
            "VOCABULARY",
        ),
    ),
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


def upgrade() -> None:
    op.add_column(
        "bundles",
        sa.Column("scenarios_imported", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.bulk_insert(
        prompt_templates,
        [
            {
                "id": new_id(),
                "name": template.name,
                "version": template.version,
                "text": read_shipped_text(template),
                "variables": list(template.variables),
                "is_current": True,
            }
            for template in SHIPPED_TEMPLATES
        ],
    )


def downgrade() -> None:
    for template in SHIPPED_TEMPLATES:
        op.execute(
            prompt_templates.delete().where(
                sa.and_(
                    prompt_templates.c.name == template.name,
                    prompt_templates.c.version == template.version,
                )
            )
        )
    op.drop_column("bundles", "scenarios_imported")
