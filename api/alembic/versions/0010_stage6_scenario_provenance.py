import uuid
from collections.abc import Sequence

import sqlalchemy as sa
import uuid_utils
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HAS_AUTHORED_KEY = "(provenance ->> 'authored_key') IS NOT NULL"
GENERATOR_OBJECT = "jsonb_typeof(s.provenance -> 'generator') = 'object'"


def new_id() -> uuid.UUID:
    return uuid.UUID(int=uuid_utils.uuid7().int)


def backfill_scenario_provenance() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    existing = sa.text(
        "SELECT s.id AS scenario_id, s.cell_id, s.bundle_id, b.version AS bundle_version, "
        f"CASE WHEN {GENERATOR_OBJECT} THEN s.provenance -> 'generator' END AS generator, "
        "s.created_at "
        "FROM scenarios s JOIN bundles b ON b.id = s.bundle_id"
    ).columns(
        sa.column("scenario_id", sa.Uuid()),
        sa.column("cell_id", sa.Uuid()),
        sa.column("bundle_id", sa.Uuid()),
        sa.column("bundle_version", sa.Integer()),
        sa.column("generator", jsonb),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    rows = op.get_bind().execute(existing).mappings().all()
    provenance = sa.table(
        "scenario_provenance",
        sa.column("id", sa.Uuid()),
        sa.column("scenario_id", sa.Uuid()),
        sa.column("cell_id", sa.Uuid()),
        sa.column("bundle_id", sa.Uuid()),
        sa.column("bundle_version", sa.Integer()),
        sa.column("generator", postgresql.JSONB(astext_type=sa.Text(), none_as_null=True)),
        sa.column("dry_runs", jsonb),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    values = [
        {
            "id": new_id(),
            "scenario_id": row["scenario_id"],
            "cell_id": row["cell_id"],
            "bundle_id": row["bundle_id"],
            "bundle_version": row["bundle_version"],
            "generator": row["generator"],
            "dry_runs": [],
            "created_at": row["created_at"],
        }
        for row in rows
    ]
    if values:
        op.bulk_insert(provenance, values)


def upgrade() -> None:
    op.add_column("coverage_cells", sa.Column("reason", sa.Text(), nullable=True))
    op.add_column("coverage_cells", sa.Column("skip_reason", sa.Text(), nullable=True))
    op.add_column(
        "plans",
        sa.Column("is_coverage_baseline", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "plans",
        sa.Column("include_api_fuzz", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.create_index(
        "uq_plans_target_id_bundle_id_coverage_baseline",
        "plans",
        ["target_id", "bundle_id"],
        unique=True,
        postgresql_where=sa.text("is_coverage_baseline"),
    )

    op.create_table(
        "scenario_provenance",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scenario_id", sa.Uuid(), nullable=False),
        sa.Column("cell_id", sa.Uuid(), nullable=True),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("bundle_version", sa.Integer(), nullable=False),
        sa.Column("finding_id", sa.Uuid(), nullable=True),
        sa.Column("ticket_url", sa.Text(), nullable=True),
        sa.Column("prompt_issue_id", sa.Uuid(), nullable=True),
        sa.Column("replay_id", sa.Uuid(), nullable=True),
        sa.Column("generator", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "dry_runs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
            name=op.f("fk_scenario_provenance_scenario_id_scenarios"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["cell_id"],
            ["coverage_cells.id"],
            name=op.f("fk_scenario_provenance_cell_id_coverage_cells"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_scenario_provenance_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"],
            ["findings.id"],
            name=op.f("fk_scenario_provenance_finding_id_findings"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["prompt_issue_id"],
            ["prompt_issues.id"],
            name=op.f("fk_scenario_provenance_prompt_issue_id_prompt_issues"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scenario_provenance")),
        sa.UniqueConstraint("scenario_id", name=op.f("uq_scenario_provenance_scenario_id")),
    )
    op.create_index(
        "ix_scenario_provenance_cell_id", "scenario_provenance", ["cell_id"], unique=False
    )
    op.create_index(
        "ix_scenario_provenance_finding_id", "scenario_provenance", ["finding_id"], unique=False
    )
    backfill_scenario_provenance()

    op.create_table(
        "scenario_versions",
        sa.Column("scenario_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("yaml", sa.Text(), nullable=False),
        sa.Column("parsed", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
            name=op.f("fk_scenario_versions_scenario_id_scenarios"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_scenario_versions_created_by_users")
        ),
        sa.PrimaryKeyConstraint("scenario_id", "version", name=op.f("pk_scenario_versions")),
    )
    op.execute(
        "INSERT INTO scenario_versions (scenario_id, version, yaml, parsed, created_by, "
        "created_at, note) "
        "SELECT id, version, yaml, parsed, NULL, created_at, NULL FROM scenarios"
    )

    op.create_index(
        "uq_scenarios_target_id_authored_key",
        "scenarios",
        ["target_id", sa.text("(provenance ->> 'authored_key')")],
        unique=True,
        postgresql_where=sa.text(HAS_AUTHORED_KEY),
    )


def downgrade() -> None:
    op.drop_index("uq_scenarios_target_id_authored_key", table_name="scenarios")
    op.drop_table("scenario_versions")
    op.drop_index("ix_scenario_provenance_finding_id", table_name="scenario_provenance")
    op.drop_index("ix_scenario_provenance_cell_id", table_name="scenario_provenance")
    op.drop_table("scenario_provenance")
    op.drop_index("uq_plans_target_id_bundle_id_coverage_baseline", table_name="plans")
    op.drop_column("plans", "include_api_fuzz")
    op.drop_column("plans", "is_coverage_baseline")
    op.drop_column("coverage_cells", "skip_reason")
    op.drop_column("coverage_cells", "reason")
