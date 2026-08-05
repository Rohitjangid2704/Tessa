from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_ARRAY = sa.text("'[]'::jsonb")
NOW = sa.text("now()")
ZERO = sa.text("0")
FALSE = sa.text("false")
DEFAULT_SOURCE_PATH = sa.text("'tessa/'")
SLACK_ONLY_NOTIFY = sa.text("""'{"slack": false}'::jsonb""")
SLACK_AND_EMAIL_NOTIFY = sa.text("""'{"slack": false, "email": []}'::jsonb""")
REMOVED_RUN_KINDS = "('contract', 'import', 'calibration', 'replay')"
REMOVED_RUNS = f"SELECT id FROM runs WHERE kind IN {REMOVED_RUN_KINDS}"
REMOVED_MODEL_CALL_ROLES = "('generate', 'explore', 'simulate', 'attack', 'skeptic', 'jev')"
REMOVED_ADAPTERS = "('webhook', 'cli')"
REMOVED_STEP_KINDS = "('webhook', 'cli', 'pipeline')"
REFUSE_ROUNDLESS_ATTACKS = (
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM attacks WHERE round_id IS NULL) THEN "
    "RAISE EXCEPTION 'Refusing to downgrade 0021 because attacks without a red team round "
    "exist; delete them first'; END IF; END $$"
)


def jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def timestamp(name: str, nullable: bool = False, default_now: bool = False) -> sa.Column[Any]:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=NOW if default_now else None,
        nullable=nullable,
    )


def delete_rows_of_removed_features() -> None:
    op.execute(
        f"DELETE FROM findings WHERE first_seen_run_id IN ({REMOVED_RUNS}) "
        f"OR last_seen_run_id IN ({REMOVED_RUNS})"
    )
    op.execute(f"DELETE FROM run_events WHERE run_id IN ({REMOVED_RUNS})")
    op.execute(f"DELETE FROM runs WHERE kind IN {REMOVED_RUN_KINDS}")
    op.execute(f"DELETE FROM model_calls WHERE role IN {REMOVED_MODEL_CALL_ROLES}")
    op.execute(
        f"DELETE FROM steps WHERE adapter IN {REMOVED_ADAPTERS} "
        f"OR request->>'kind' IN {REMOVED_STEP_KINDS} "
        f"OR response->>'kind' IN {REMOVED_STEP_KINDS}"
    )


def drop_run_groups_and_contract_checks() -> None:
    op.drop_index(
        "ix_contract_checks_consumer_bundle_id_provider_bundle_id", table_name="contract_checks"
    )
    op.drop_table("contract_checks")
    op.drop_index("ix_runs_run_group_id", table_name="runs")
    op.drop_constraint(op.f("fk_runs_run_group_id_run_groups"), "runs", type_="foreignkey")
    op.drop_column("runs", "run_group_id")
    op.drop_table("run_groups")
    op.drop_table("bundle_sources")


def drop_replays() -> None:
    op.drop_constraint(
        op.f("fk_scenario_provenance_replay_id_replays"),
        "scenario_provenance",
        type_="foreignkey",
    )
    op.drop_column("scenario_provenance", "replay_id")
    op.drop_index("ix_replay_records_replay_id_status", table_name="replay_records")
    op.drop_table("replay_records")
    op.drop_index("ix_replays_target_id_created_at", table_name="replays")
    op.drop_table("replays")


def drop_redteam_rounds() -> None:
    op.drop_constraint(op.f("fk_attacks_round_id_redteam_rounds"), "attacks", type_="foreignkey")
    op.alter_column("attacks", "round_id", existing_type=sa.Uuid(), nullable=True)
    op.drop_table("redteam_rounds")


def drop_teams_and_traffic() -> None:
    op.drop_column("targets", "allow_jev")
    op.drop_index(op.f("ix_targets_team_id"), table_name="targets")
    op.drop_constraint(op.f("fk_targets_team_id_teams"), "targets", type_="foreignkey")
    op.drop_column("targets", "team_id")
    op.drop_index("ix_traffic_probe_results_bucket_hour", table_name="traffic_probe_results")
    op.drop_table("traffic_probe_results")
    op.drop_table("team_budgets")
    op.drop_index(op.f("ix_team_members_user_id"), table_name="team_members")
    op.drop_table("team_members")
    op.drop_table("teams")


def drop_email_from_schedule_notify() -> None:
    op.execute("UPDATE schedules SET notify = notify - 'email'")
    op.alter_column("schedules", "notify", existing_type=jsonb(), server_default=SLACK_ONLY_NOTIFY)


def upgrade() -> None:
    delete_rows_of_removed_features()
    drop_run_groups_and_contract_checks()
    drop_replays()
    drop_redteam_rounds()
    drop_teams_and_traffic()
    drop_email_from_schedule_notify()


def restore_email_in_schedule_notify() -> None:
    op.alter_column(
        "schedules", "notify", existing_type=jsonb(), server_default=SLACK_AND_EMAIL_NOTIFY
    )
    op.execute("""UPDATE schedules SET notify = notify || '{"email": []}'::jsonb""")


def restore_teams_and_traffic() -> None:
    op.create_table(
        "teams",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_teams")),
        sa.UniqueConstraint("name", name=op.f("uq_teams_name")),
    )
    op.create_table(
        "team_members",
        sa.Column("team_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["team_id"],
            ["teams.id"],
            name=op.f("fk_team_members_team_id_teams"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_team_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("team_id", "user_id", name=op.f("pk_team_members")),
    )
    op.create_index(op.f("ix_team_members_user_id"), "team_members", ["user_id"], unique=False)
    op.create_table(
        "team_budgets",
        sa.Column("team_id", sa.Uuid(), nullable=False),
        sa.Column("month", sa.Date(), nullable=False),
        sa.Column("max_usd_month", sa.Numeric(12, 6), nullable=False),
        sa.ForeignKeyConstraint(
            ["team_id"],
            ["teams.id"],
            name=op.f("fk_team_budgets_team_id_teams"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("team_id", "month", name=op.f("pk_team_budgets")),
    )
    op.create_table(
        "traffic_probe_results",
        sa.Column("target_id", sa.Uuid(), nullable=False),
        timestamp("bucket_hour"),
        sa.Column("probe_id", sa.Text(), nullable=False),
        sa.Column("decided", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("violations", sa.Integer(), server_default=ZERO, nullable=False),
        sa.Column("uncertain", sa.Integer(), server_default=ZERO, nullable=False),
        sa.ForeignKeyConstraint(
            ["target_id"],
            ["targets.id"],
            name=op.f("fk_traffic_probe_results_target_id_targets"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "target_id", "bucket_hour", "probe_id", name=op.f("pk_traffic_probe_results")
        ),
    )
    op.create_index(
        "ix_traffic_probe_results_bucket_hour",
        "traffic_probe_results",
        ["bucket_hour"],
        unique=False,
    )
    op.add_column("targets", sa.Column("team_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_targets_team_id_teams"),
        "targets",
        "teams",
        ["team_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(op.f("ix_targets_team_id"), "targets", ["team_id"], unique=False)
    op.add_column(
        "targets",
        sa.Column("allow_jev", sa.Boolean(), server_default=FALSE, nullable=False),
    )


def restore_redteam_rounds() -> None:
    op.execute(REFUSE_ROUNDLESS_ATTACKS)
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
    op.alter_column("attacks", "round_id", existing_type=sa.Uuid(), nullable=False)
    op.create_foreign_key(
        op.f("fk_attacks_round_id_redteam_rounds"),
        "attacks",
        "redteam_rounds",
        ["round_id"],
        ["id"],
        ondelete="CASCADE",
    )


def restore_replays() -> None:
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
    op.add_column("scenario_provenance", sa.Column("replay_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_scenario_provenance_replay_id_replays"),
        "scenario_provenance",
        "replays",
        ["replay_id"],
        ["id"],
        ondelete="SET NULL",
    )


def restore_run_groups_and_contract_checks() -> None:
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


def downgrade() -> None:
    restore_email_in_schedule_notify()
    restore_teams_and_traffic()
    restore_redteam_rounds()
    restore_replays()
    restore_run_groups_and_contract_checks()
