from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "prompt_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column(
            "variables",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("is_current", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prompt_templates")),
        sa.UniqueConstraint("name", "version", name=op.f("uq_prompt_templates_name_version")),
    )
    op.create_index(
        "uq_prompt_templates_current_name",
        "prompt_templates",
        ["name"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )

    op.create_table(
        "prompt_issues",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("template_name", sa.Text(), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=True),
        sa.Column("finding_id", sa.Uuid(), nullable=True),
        sa.Column("issued_by", sa.Uuid(), nullable=False),
        sa.Column(
            "issued_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_prompt_issues_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["issued_by"], ["users.id"], name=op.f("fk_prompt_issues_issued_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prompt_issues")),
    )
    op.create_index(
        "ix_prompt_issues_target_id_issued_at",
        "prompt_issues",
        ["target_id", sa.text("issued_at DESC")],
        unique=False,
    )

    op.add_column("targets", sa.Column("previous_target_token", sa.Text(), nullable=True))
    op.create_unique_constraint(
        op.f("uq_targets_previous_target_token"), "targets", ["previous_target_token"]
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_targets_previous_target_token"), "targets", type_="unique")
    op.drop_column("targets", "previous_target_token")
    op.drop_index("ix_prompt_issues_target_id_issued_at", table_name="prompt_issues")
    op.drop_table("prompt_issues")
    op.drop_index("uq_prompt_templates_current_name", table_name="prompt_templates")
    op.drop_table("prompt_templates")
