from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_ARRAY = sa.text("'[]'::jsonb")
NOW = sa.text("now()")
ZERO = sa.text("0")
DEFAULT_SOURCE_PATH = sa.text("'tessa/'")


def jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def timestamp(name: str, nullable: bool = False, default_now: bool = False) -> sa.Column[Any]:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=NOW if default_now else None,
        nullable=nullable,
    )


def create_run_groups() -> None:
    op.create_table(
        "run_groups",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_ids", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_run_groups_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_run_groups")),
    )
    op.add_column("runs", sa.Column("run_group_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_runs_run_group_id_run_groups"),
        "runs",
        "run_groups",
        ["run_group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_runs_run_group_id", "runs", ["run_group_id"], unique=False)


def create_contract_checks() -> None:
    op.create_table(
        "contract_checks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("consumer_bundle_id", sa.Uuid(), nullable=False),
        sa.Column("provider_bundle_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("breaking", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("items", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        timestamp("created_at", default_now=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contract_checks")),
        sa.UniqueConstraint("run_id", name=op.f("uq_contract_checks_run_id")),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_contract_checks_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["consumer_bundle_id"],
            ["bundles.id"],
            name=op.f("fk_contract_checks_consumer_bundle_id_bundles"),
        ),
        sa.ForeignKeyConstraint(
            ["provider_bundle_id"],
            ["bundles.id"],
            name=op.f("fk_contract_checks_provider_bundle_id_bundles"),
        ),
    )
    op.create_index(
        "ix_contract_checks_consumer_bundle_id_provider_bundle_id",
        "contract_checks",
        ["consumer_bundle_id", "provider_bundle_id"],
        unique=False,
    )


def create_bundle_sources() -> None:
    op.create_table(
        "bundle_sources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("git_url", sa.Text(), nullable=False),
        sa.Column("branch", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), server_default=DEFAULT_SOURCE_PATH, nullable=False),
        sa.Column("credential_name", sa.Text(), nullable=False),
        timestamp("last_pulled_at", nullable=True),
        sa.Column("last_ref", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bundle_sources")),
        sa.UniqueConstraint("target_id", name=op.f("uq_bundle_sources_target_id")),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_bundle_sources_target_id_targets")
        ),
    )


def upgrade() -> None:
    create_run_groups()
    create_contract_checks()
    create_bundle_sources()


def downgrade() -> None:
    op.drop_table("bundle_sources")
    op.drop_index(
        "ix_contract_checks_consumer_bundle_id_provider_bundle_id", table_name="contract_checks"
    )
    op.drop_table("contract_checks")
    op.drop_index("ix_runs_run_group_id", table_name="runs")
    op.drop_constraint(op.f("fk_runs_run_group_id_run_groups"), "runs", type_="foreignkey")
    op.drop_column("runs", "run_group_id")
    op.drop_table("run_groups")
