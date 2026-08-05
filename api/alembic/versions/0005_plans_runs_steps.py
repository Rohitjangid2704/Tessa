from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NON_TERMINAL_WHERE = "status IN ('queued', 'planning', 'seeding', 'running', 'canceling')"
EMBEDDING_DIMENSIONS = 1536


def upgrade() -> None:
    op.create_table(
        "plans",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("saved", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("selection", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("depth", sa.Text(), nullable=False),
        sa.Column("k", sa.Integer(), nullable=False),
        sa.Column("budget", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("schedule", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_plans_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_plans_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_plans_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_plans")),
    )
    op.create_index(
        "ix_plans_target_id_created_at",
        "plans",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )

    op.create_table(
        "coverage_cells",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("feature_id", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("interface_id", sa.Text(), nullable=False),
        sa.Column("family", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("last_verdict", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["plan_id"],
            ["plans.id"],
            name=op.f("fk_coverage_cells_plan_id_plans"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_coverage_cells")),
        sa.UniqueConstraint(
            "plan_id",
            "feature_id",
            "role",
            "interface_id",
            name=op.f("uq_coverage_cells_plan_id_feature_id_role_interface_id"),
        ),
    )

    op.create_table(
        "scenarios",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=False),
        sa.Column("feature_id", sa.Text(), nullable=True),
        sa.Column("cell_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("family", sa.Text(), nullable=False),
        sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("yaml", sa.Text(), nullable=False),
        sa.Column("parsed", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("validation", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("provenance", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSIONS), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_scenarios_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_scenarios_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["cell_id"],
            ["coverage_cells.id"],
            name=op.f("fk_scenarios_cell_id_coverage_cells"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_scenarios")),
    )
    op.create_index(
        "ix_scenarios_target_id_feature_id", "scenarios", ["target_id", "feature_id"], unique=False
    )

    op.create_table(
        "runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=True),
        sa.Column("plan_id", sa.Uuid(), nullable=True),
        sa.Column("bundle_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("trigger", sa.Text(), nullable=False),
        sa.Column("read_only", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("config_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("budget", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("spent_usd", sa.Numeric(12, 6), server_default=sa.text("0"), nullable=False),
        sa.Column("counters", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("workflow_id", sa.Text(), nullable=False),
        sa.Column("event_head_seq", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_runs_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["plan_id"], ["plans.id"], name=op.f("fk_runs_plan_id_plans"), ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"], ["bundles.id"], name=op.f("fk_runs_bundle_id_bundles")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_runs_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_runs")),
        sa.UniqueConstraint("workflow_id", name=op.f("uq_runs_workflow_id")),
    )
    op.create_index(
        "ix_runs_target_id_created_at",
        "runs",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_runs_status_non_terminal",
        "runs",
        ["status"],
        unique=False,
        postgresql_where=sa.text(NON_TERMINAL_WHERE),
    )

    op.create_table(
        "run_scenarios",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("scenario_id", sa.Uuid(), nullable=False),
        sa.Column("scenario_version", sa.Integer(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("interface_id", sa.Text(), nullable=False),
        sa.Column("attempts_total", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("verdict", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column(
            "attempts",
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
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_run_scenarios_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"], ["scenarios.id"], name=op.f("fk_run_scenarios_scenario_id_scenarios")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_run_scenarios")),
        sa.UniqueConstraint(
            "run_id",
            "scenario_id",
            "role",
            "interface_id",
            name=op.f("uq_run_scenarios_run_id_scenario_id_role_interface_id"),
        ),
    )
    op.create_index("ix_run_scenarios_run_id", "run_scenarios", ["run_id"], unique=False)

    op.create_table(
        "steps",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_scenario_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("index", sa.Integer(), nullable=False),
        sa.Column("adapter", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("request", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("response", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("response_truncated", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("ask", sa.Text(), nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column(
            "tools",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "cards",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("tier0", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(12, 6), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "artifacts",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("verdict", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ok", sa.Boolean(), nullable=True),
        sa.Column("tier0_failure_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("screenshot_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_scenario_id"],
            ["run_scenarios.id"],
            name=op.f("fk_steps_run_scenario_id_run_scenarios"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_steps_run_id_runs"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_steps")),
        sa.UniqueConstraint(
            "run_scenario_id",
            "attempt",
            "index",
            name=op.f("uq_steps_run_scenario_id_attempt_index"),
        ),
    )
    op.create_index("ix_steps_run_id", "steps", ["run_id"], unique=False)

    op.create_table(
        "browser_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("run_scenario_id", sa.Uuid(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("viewport", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("last_url", sa.Text(), nullable=True),
        sa.Column("recording", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("trace", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_browser_sessions_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_scenario_id"],
            ["run_scenarios.id"],
            name=op.f("fk_browser_sessions_run_scenario_id_run_scenarios"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_browser_sessions")),
    )
    op.create_index("ix_browser_sessions_run_id", "browser_sessions", ["run_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_browser_sessions_run_id", table_name="browser_sessions")
    op.drop_table("browser_sessions")
    op.drop_index("ix_steps_run_id", table_name="steps")
    op.drop_table("steps")
    op.drop_index("ix_run_scenarios_run_id", table_name="run_scenarios")
    op.drop_table("run_scenarios")
    op.drop_index("ix_runs_status_non_terminal", table_name="runs")
    op.drop_index("ix_runs_target_id_created_at", table_name="runs")
    op.drop_table("runs")
    op.drop_index("ix_scenarios_target_id_feature_id", table_name="scenarios")
    op.drop_table("scenarios")
    op.drop_table("coverage_cells")
    op.drop_index("ix_plans_target_id_created_at", table_name="plans")
    op.drop_table("plans")
