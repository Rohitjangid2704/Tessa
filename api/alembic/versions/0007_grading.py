from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "probe_results",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("step_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("probe_id", sa.Text(), nullable=False),
        sa.Column("pack", sa.Text(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("threshold", sa.Float(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("probe_bank_version", sa.Text(), nullable=False),
        sa.Column("engine", sa.Text(), server_default="laya", nullable=False),
        sa.ForeignKeyConstraint(
            ["step_id"],
            ["steps.id"],
            name=op.f("fk_probe_results_step_id_steps"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_probe_results_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_probe_results")),
    )
    op.create_index("ix_probe_results_step_id", "probe_results", ["step_id"], unique=False)
    op.create_index(
        "ix_probe_results_run_id_probe_id", "probe_results", ["run_id", "probe_id"], unique=False
    )

    op.create_table(
        "judge_results",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("step_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("family", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("effort", sa.Text(), nullable=False),
        sa.Column("rubric_version", sa.Text(), nullable=False),
        sa.Column("verdict", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("pairwise", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cost_usd", sa.Numeric(12, 6), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["step_id"],
            ["steps.id"],
            name=op.f("fk_judge_results_step_id_steps"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_judge_results_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_judge_results")),
    )
    op.create_index("ix_judge_results_step_id", "judge_results", ["step_id"], unique=False)

    op.create_table(
        "labels",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("subject_type", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("labeled_by", sa.Uuid(), nullable=True),
        sa.Column(
            "labeled_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["labeled_by"], ["users.id"], name=op.f("fk_labels_labeled_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_labels")),
        sa.UniqueConstraint(
            "subject_type",
            "subject_id",
            "source",
            "labeled_by",
            name=op.f("uq_labels_subject_type_subject_id_source_labeled_by"),
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_index(
        "ix_labels_subject_type_subject_id",
        "labels",
        ["subject_type", "subject_id"],
        unique=False,
    )

    op.add_column(
        "steps",
        sa.Column("evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("steps", "evidence")
    op.drop_index("ix_labels_subject_type_subject_id", table_name="labels")
    op.drop_table("labels")
    op.drop_index("ix_judge_results_step_id", table_name="judge_results")
    op.drop_table("judge_results")
    op.drop_index("ix_probe_results_run_id_probe_id", table_name="probe_results")
    op.drop_index("ix_probe_results_step_id", table_name="probe_results")
    op.drop_table("probe_results")
