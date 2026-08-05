from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "bundles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("hash", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("validation_status", sa.Text(), nullable=False),
        sa.Column(
            "errors",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("completeness", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("diff_summary", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("manifest", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("feature_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("file_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "files",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("storage_path", sa.Text(), nullable=True),
        sa.Column("uploaded_by", sa.Uuid(), nullable=False),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_bundles_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"], ["users.id"], name=op.f("fk_bundles_uploaded_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bundles")),
        sa.UniqueConstraint("target_id", "version", name=op.f("uq_bundles_target_id_version")),
        sa.UniqueConstraint("target_id", "hash", name=op.f("uq_bundles_target_id_hash")),
    )
    op.create_index(
        "ix_bundles_target_id_version",
        "bundles",
        ["target_id", sa.text("version DESC")],
        unique=False,
    )

    op.create_foreign_key(
        op.f("fk_prompt_issues_bundle_id_bundles"),
        "prompt_issues",
        "bundles",
        ["bundle_id"],
        ["id"],
    )

    op.create_table(
        "catalog_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("feature_id", sa.Text(), nullable=False),
        sa.Column("area", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column(
            "interface_ids",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column(
            "roles", postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False
        ),
        sa.Column("flag", sa.Text(), nullable=False),
        sa.Column(
            "preconditions",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column(
            "examples",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "invariants",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("cleanup", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.Column("raw", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_catalog_items_bundle_id_bundles")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_catalog_items")),
        sa.UniqueConstraint(
            "bundle_id", "feature_id", name=op.f("uq_catalog_items_bundle_id_feature_id")
        ),
    )
    op.create_index(
        "ix_catalog_items_bundle_id_area", "catalog_items", ["bundle_id", "area"], unique=False
    )

    op.create_table(
        "environments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("secret", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("required", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("purpose", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "interface_ids",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("encrypted_value", sa.LargeBinary(), nullable=True),
        sa.Column("stale", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("last_set_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_set_by", sa.Uuid(), nullable=True),
        sa.Column("last_health", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_environments_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["last_set_by"], ["users.id"], name=op.f("fk_environments_last_set_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_environments")),
        sa.UniqueConstraint("target_id", "name", name=op.f("uq_environments_target_id_name")),
    )

    op.add_column(
        "targets",
        sa.Column("health_report", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "targets", sa.Column("health_checked_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("targets", "health_checked_at")
    op.drop_column("targets", "health_report")
    op.drop_table("environments")
    op.drop_index("ix_catalog_items_bundle_id_area", table_name="catalog_items")
    op.drop_table("catalog_items")
    op.drop_constraint(
        op.f("fk_prompt_issues_bundle_id_bundles"), "prompt_issues", type_="foreignkey"
    )
    op.drop_index("ix_bundles_target_id_version", table_name="bundles")
    op.drop_table("bundles")
