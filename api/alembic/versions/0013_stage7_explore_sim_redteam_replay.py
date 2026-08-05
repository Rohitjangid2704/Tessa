from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_ARRAY = sa.text("'[]'::jsonb")
NOW = sa.text("now()")
ZERO = sa.text("0")
FALSE = sa.text("false")


def jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def timestamp(name: str, nullable: bool = False, default_now: bool = False) -> sa.Column[Any]:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=NOW if default_now else None,
        nullable=nullable,
    )


def create_personas_and_goals() -> None:
    op.create_table(
        "personas",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("traits", jsonb(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_personas_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_personas_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_personas")),
        sa.UniqueConstraint("target_id", "name", name=op.f("uq_personas_target_id_name")),
    )
    op.create_index(
        "ix_personas_target_id_created_at",
        "personas",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "goals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("statement", sa.Text(), nullable=False),
        sa.Column("success_criteria", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.Column("role", sa.Text(), nullable=True),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_goals_target_id_targets")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goals")),
    )
    op.create_index(
        "ix_goals_target_id_created_at",
        "goals",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )


def create_sim_sessions() -> None:
    op.create_table(
        "sim_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("persona_id", sa.Uuid(), nullable=False),
        sa.Column("goal_id", sa.Uuid(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("transcript", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.Column("checks", jsonb(), nullable=True),
        sa.Column("verdict", jsonb(), nullable=True),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_sim_sessions_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["persona_id"], ["personas.id"], name=op.f("fk_sim_sessions_persona_id_personas")
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"], ["goals.id"], name=op.f("fk_sim_sessions_goal_id_goals")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sim_sessions")),
        sa.UniqueConstraint("run_id", "attempt", name=op.f("uq_sim_sessions_run_id_attempt")),
    )
    op.create_index("ix_sim_sessions_persona_id", "sim_sessions", ["persona_id"], unique=False)
    op.create_index("ix_sim_sessions_goal_id", "sim_sessions", ["goal_id"], unique=False)


def create_redteam() -> None:
    op.create_table(
        "redteam_rounds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("index", sa.Integer(), nullable=False),
        sa.Column("family", sa.Text(), nullable=False),
        sa.Column("dry", sa.Boolean(), server_default=FALSE, nullable=False),
        timestamp("started_at", default_now=True),
        timestamp("finished_at", nullable=True),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_redteam_rounds_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_redteam_rounds")),
        sa.UniqueConstraint(
            "run_id", "index", "family", name=op.f("uq_redteam_rounds_run_id_index_family")
        ),
    )
    op.create_table(
        "attacks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("round_id", sa.Uuid(), nullable=False),
        sa.Column("family", sa.Text(), nullable=False),
        sa.Column("prompt_excerpt", sa.Text(), nullable=False),
        sa.Column("response_excerpt", sa.Text(), nullable=False),
        sa.Column("outcome", sa.Text(), nullable=False),
        sa.Column("skeptic_verdict", jsonb(), nullable=True),
        sa.Column("finding_id", sa.Uuid(), nullable=True),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_attacks_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["round_id"],
            ["redteam_rounds.id"],
            name=op.f("fk_attacks_round_id_redteam_rounds"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"],
            ["findings.id"],
            name=op.f("fk_attacks_finding_id_findings"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_attacks")),
    )
    op.create_index("ix_attacks_run_id_outcome", "attacks", ["run_id", "outcome"], unique=False)
    op.create_index("ix_attacks_round_id", "attacks", ["round_id"], unique=False)


def create_replays() -> None:
    op.create_table(
        "replays",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("source_name", sa.Text(), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=True),
        sa.Column("records_total", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("cases_created", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("cases_rejected", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_replays_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_replays_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_replays_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_replays")),
        sa.UniqueConstraint("run_id", name=op.f("uq_replays_run_id")),
    )
    op.create_index(
        "ix_replays_target_id_created_at",
        "replays",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "replay_records",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("replay_id", sa.Uuid(), nullable=False),
        sa.Column("index", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("reason_code", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("scenario_id", sa.Uuid(), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["replay_id"],
            ["replays.id"],
            name=op.f("fk_replay_records_replay_id_replays"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["scenario_id"],
            ["scenarios.id"],
            name=op.f("fk_replay_records_scenario_id_scenarios"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_replay_records")),
        sa.UniqueConstraint("replay_id", "index", name=op.f("uq_replay_records_replay_id_index")),
    )
    op.create_index(
        "ix_replay_records_replay_id_status",
        "replay_records",
        ["replay_id", "status"],
        unique=False,
    )
    op.create_foreign_key(
        op.f("fk_scenario_provenance_replay_id_replays"),
        "scenario_provenance",
        "replays",
        ["replay_id"],
        ["id"],
        ondelete="SET NULL",
    )


def create_exploration_candidates() -> None:
    op.create_table(
        "exploration_candidates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("run_scenario_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("detector", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("from_index", sa.Integer(), nullable=False),
        sa.Column("to_index", sa.Integer(), nullable=False),
        sa.Column("assertion", jsonb(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("finding_id", sa.Uuid(), nullable=True),
        timestamp("created_at", default_now=True),
        timestamp("verified_at", nullable=True),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_exploration_candidates_run_id_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_scenario_id"],
            ["run_scenarios.id"],
            name=op.f("fk_exploration_candidates_run_scenario_id_run_scenarios"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["finding_id"],
            ["findings.id"],
            name=op.f("fk_exploration_candidates_finding_id_findings"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_exploration_candidates")),
    )
    op.create_index(
        "ix_exploration_candidates_run_id_status",
        "exploration_candidates",
        ["run_id", "status"],
        unique=False,
    )


def upgrade() -> None:
    op.add_column("runs", sa.Column("stop_requested_at", sa.DateTime(timezone=True), nullable=True))
    create_personas_and_goals()
    create_sim_sessions()
    create_redteam()
    create_replays()
    create_exploration_candidates()


def downgrade() -> None:
    op.drop_index("ix_exploration_candidates_run_id_status", table_name="exploration_candidates")
    op.drop_table("exploration_candidates")
    op.drop_constraint(
        op.f("fk_scenario_provenance_replay_id_replays"),
        "scenario_provenance",
        type_="foreignkey",
    )
    op.drop_index("ix_replay_records_replay_id_status", table_name="replay_records")
    op.drop_table("replay_records")
    op.drop_index("ix_replays_target_id_created_at", table_name="replays")
    op.drop_table("replays")
    op.drop_index("ix_attacks_round_id", table_name="attacks")
    op.drop_index("ix_attacks_run_id_outcome", table_name="attacks")
    op.drop_table("attacks")
    op.drop_table("redteam_rounds")
    op.drop_index("ix_sim_sessions_goal_id", table_name="sim_sessions")
    op.drop_index("ix_sim_sessions_persona_id", table_name="sim_sessions")
    op.drop_table("sim_sessions")
    op.drop_index("ix_goals_target_id_created_at", table_name="goals")
    op.drop_table("goals")
    op.drop_index("ix_personas_target_id_created_at", table_name="personas")
    op.drop_table("personas")
    op.drop_column("runs", "stop_requested_at")
