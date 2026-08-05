from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008_p4gr"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMBEDDING_DIMENSIONS = 1536
HNSW_INDEXES = (
    ("ix_findings_embedding_hnsw", "findings"),
    ("ix_scenarios_embedding_hnsw", "scenarios"),
)


def upgrade() -> None:
    op.add_column(
        "runs", sa.Column("stats", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )

    op.create_table(
        "invariant_results",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("run_scenario_id", sa.Uuid(), nullable=True),
        sa.Column("step_id", sa.Uuid(), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=True),
        sa.Column("invariant_id", sa.Text(), nullable=False),
        sa.Column("pack", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_invariant_results_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_scenario_id"],
            ["run_scenarios.id"],
            name=op.f("fk_invariant_results_run_scenario_id_run_scenarios"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["step_id"],
            ["steps.id"],
            name=op.f("fk_invariant_results_step_id_steps"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invariant_results")),
    )
    op.create_index(
        "ix_invariant_results_run_id_invariant_id_status",
        "invariant_results",
        ["run_id", "invariant_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_invariant_results_run_scenario_id",
        "invariant_results",
        ["run_scenario_id"],
        unique=False,
    )

    op.create_table(
        "findings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("class", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("invariant_id", sa.Text(), nullable=True),
        sa.Column("scenario_id", sa.Uuid(), nullable=True),
        sa.Column("first_seen_run_id", sa.Uuid(), nullable=False),
        sa.Column("last_seen_run_id", sa.Uuid(), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("occurrence_count", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("ticket_url", sa.Text(), nullable=True),
        sa.Column("known_gap_reason", sa.Text(), nullable=True),
        sa.Column("promoted_scenario_id", sa.Uuid(), nullable=True),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSIONS), nullable=True),
        sa.Column("repro", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_findings_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
            name=op.f("fk_findings_scenario_id_scenarios"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["first_seen_run_id"], ["runs.id"], name=op.f("fk_findings_first_seen_run_id_runs")
        ),
        sa.ForeignKeyConstraint(
            ["last_seen_run_id"], ["runs.id"], name=op.f("fk_findings_last_seen_run_id_runs")
        ),
        sa.ForeignKeyConstraint(
            ["promoted_scenario_id"],
            ["scenarios.id"],
            name=op.f("fk_findings_promoted_scenario_id_scenarios"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_findings")),
        sa.UniqueConstraint(
            "target_id", "fingerprint", name=op.f("uq_findings_target_id_fingerprint")
        ),
    )
    op.create_index(
        "ix_findings_target_id_status_last_seen_at",
        "findings",
        ["target_id", "status", sa.text("last_seen_at DESC")],
        unique=False,
    )

    op.create_table(
        "finding_occurrences",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("finding_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("run_scenario_id", sa.Uuid(), nullable=True),
        sa.Column("step_id", sa.Uuid(), nullable=True),
        sa.Column("attempt", sa.Integer(), nullable=True),
        sa.Column(
            "seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "evidence",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"],
            ["findings.id"],
            name=op.f("fk_finding_occurrences_finding_id_findings"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_finding_occurrences_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_scenario_id"],
            ["run_scenarios.id"],
            name=op.f("fk_finding_occurrences_run_scenario_id_run_scenarios"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["step_id"],
            ["steps.id"],
            name=op.f("fk_finding_occurrences_step_id_steps"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_finding_occurrences")),
        sa.UniqueConstraint(
            "finding_id",
            "run_id",
            "run_scenario_id",
            "step_id",
            "attempt",
            name="uq_finding_occurrences_identity",
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index(
        "ix_finding_occurrences_finding_id_seen_at",
        "finding_occurrences",
        ["finding_id", sa.text("seen_at DESC")],
        unique=False,
    )

    op.create_table(
        "explanations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("finding_id", sa.Uuid(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"],
            ["findings.id"],
            name=op.f("fk_explanations_finding_id_findings"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_explanations_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_explanations")),
    )
    op.create_index(
        "ix_explanations_finding_id_created_at",
        "explanations",
        ["finding_id", sa.text("created_at DESC")],
        unique=False,
    )

    op.create_table(
        "model_calls",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("step_id", sa.Uuid(), nullable=True),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("activity", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("effort", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_model_calls_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["step_id"],
            ["steps.id"],
            name=op.f("fk_model_calls_step_id_steps"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_calls")),
    )
    op.create_index("ix_model_calls_run_id", "model_calls", ["run_id"], unique=False)
    op.create_index("ix_model_calls_created_at", "model_calls", ["created_at"], unique=False)

    with op.get_context().autocommit_block():
        for index_name, table_name in HNSW_INDEXES:
            op.create_index(
                index_name,
                table_name,
                ["embedding"],
                unique=False,
                postgresql_using="hnsw",
                postgresql_ops={"embedding": "vector_cosine_ops"},
                postgresql_concurrently=True,
                if_not_exists=True,
            )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for index_name, table_name in HNSW_INDEXES:
            op.drop_index(
                index_name,
                table_name=table_name,
                postgresql_concurrently=True,
                if_exists=True,
            )

    op.drop_index("ix_model_calls_created_at", table_name="model_calls")
    op.drop_index("ix_model_calls_run_id", table_name="model_calls")
    op.drop_table("model_calls")
    op.drop_index("ix_explanations_finding_id_created_at", table_name="explanations")
    op.drop_table("explanations")
    op.drop_index("ix_finding_occurrences_finding_id_seen_at", table_name="finding_occurrences")
    op.drop_table("finding_occurrences")
    op.drop_index("ix_findings_target_id_status_last_seen_at", table_name="findings")
    op.drop_table("findings")
    op.drop_index("ix_invariant_results_run_scenario_id", table_name="invariant_results")
    op.drop_index("ix_invariant_results_run_id_invariant_id_status", table_name="invariant_results")
    op.drop_table("invariant_results")
    op.drop_column("runs", "stats")
