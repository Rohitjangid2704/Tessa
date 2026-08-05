from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "seeds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("declared_hash", sa.Text(), nullable=True),
        sa.Column("hash_source", sa.Text(), nullable=False),
        sa.Column("reset_script_path", sa.Text(), nullable=True),
        sa.Column("hash_command", sa.Text(), nullable=True),
        sa.Column("material_sha256", sa.Text(), nullable=False),
        sa.Column("observed_hash", sa.Text(), nullable=True),
        sa.Column("last_reset_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_reset_status", sa.Text(), nullable=True),
        sa.Column("last_reset_run_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_seeds_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_seeds_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["last_reset_run_id"],
            ["runs.id"],
            name=op.f("fk_seeds_last_reset_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_seeds")),
        sa.UniqueConstraint("target_id", "version", name=op.f("uq_seeds_target_id_version")),
    )

    op.create_table(
        "oracle_templates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("feature_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("params_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sentence_template", sa.Text(), nullable=False),
        sa.Column("read_only_verified", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("approval", sa.Text(), server_default="unreviewed", nullable=False),
        sa.Column("truth_source", sa.Text(), nullable=True),
        sa.Column(
            "gold_points",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_oracle_templates_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_oracle_templates_target_id_targets")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oracle_templates")),
        sa.UniqueConstraint("bundle_id", "name", name=op.f("uq_oracle_templates_bundle_id_name")),
    )

    op.create_table(
        "oracle_results",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("oracle_template_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("params", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "rows",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("rows_truncated", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("sentence", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["oracle_template_id"],
            ["oracle_templates.id"],
            name=op.f("fk_oracle_results_oracle_template_id_oracle_templates"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_oracle_results_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oracle_results")),
    )
    op.create_index(
        "ix_oracle_results_oracle_template_id_created_at",
        "oracle_results",
        ["oracle_template_id", sa.text("created_at DESC")],
        unique=False,
    )

    op.add_column(
        "steps",
        sa.Column(
            "gold_points",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "steps",
        sa.Column(
            "db_checks",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("steps", "db_checks")
    op.drop_column("steps", "gold_points")
    op.drop_index("ix_oracle_results_oracle_template_id_created_at", table_name="oracle_results")
    op.drop_table("oracle_results")
    op.drop_table("oracle_templates")
    op.drop_table("seeds")
