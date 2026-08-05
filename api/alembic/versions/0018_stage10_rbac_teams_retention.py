import uuid
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_OBJECT = sa.text("'{}'::jsonb")
NOW = sa.text("now()")
ZERO = sa.text("0")
DEFAULT_TEAM_NAME = "default"
DEFAULT_TEAM_ID = uuid.uuid5(uuid.NAMESPACE_URL, "tessa:team:default")
OIDC_IDENTITY_PRESENT = "oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL"
STEP_PAYLOAD_NOT_PURGED = "payload_purged_at IS NULL"
REFUSE_SSO_ONLY_DOWNGRADE = (
    "DO $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE password_hash IS NULL) THEN "
    "RAISE EXCEPTION 'Refusing to downgrade 0018 because users without a password hash "
    "(SSO-only users) exist; give them a password or delete them first'; "
    "END IF; END $$"
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


def create_teams() -> None:
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


def create_traffic_and_audit() -> None:
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
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("subject_type", sa.Text(), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=True),
        sa.Column("detail", jsonb(), server_default=EMPTY_JSON_OBJECT, nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["actor_user_id"],
            ["users.id"],
            name=op.f("fk_audit_events_actor_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_events")),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"], unique=False)
    op.create_index(
        "ix_audit_events_subject_type_subject_id",
        "audit_events",
        ["subject_type", "subject_id"],
        unique=False,
    )


def add_columns_to_earlier_tables() -> None:
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
        sa.Column("allow_jev", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column("users", sa.Column("oidc_issuer", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("oidc_subject", sa.Text(), nullable=True))
    op.create_index(
        "uq_users_oidc_issuer_oidc_subject",
        "users",
        ["oidc_issuer", "oidc_subject"],
        unique=True,
        postgresql_where=sa.text(OIDC_IDENTITY_PRESENT),
    )
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=True)
    op.add_column("steps", timestamp("payload_purged_at", nullable=True))
    op.create_index(
        "ix_steps_finished_at_unpurged",
        "steps",
        ["finished_at"],
        unique=False,
        postgresql_where=sa.text(STEP_PAYLOAD_NOT_PURGED),
    )
    op.create_index("ix_run_events_ts", "run_events", ["ts"], unique=False)


def put_existing_data_in_the_default_team() -> None:
    team_id = f"'{DEFAULT_TEAM_ID}'::uuid"
    op.execute(f"INSERT INTO teams (id, name) VALUES ({team_id}, '{DEFAULT_TEAM_NAME}')")
    op.execute(f"UPDATE targets SET team_id = {team_id}")
    op.execute(
        f"INSERT INTO team_members (team_id, user_id) SELECT {team_id}, id FROM users "
        "WHERE is_active"
    )


def upgrade() -> None:
    create_teams()
    create_traffic_and_audit()
    add_columns_to_earlier_tables()
    put_existing_data_in_the_default_team()


def downgrade() -> None:
    op.execute(REFUSE_SSO_ONLY_DOWNGRADE)
    op.drop_index("ix_run_events_ts", table_name="run_events")
    op.drop_index("ix_steps_finished_at_unpurged", table_name="steps")
    op.drop_column("steps", "payload_purged_at")
    op.alter_column("users", "password_hash", existing_type=sa.Text(), nullable=False)
    op.drop_index("uq_users_oidc_issuer_oidc_subject", table_name="users")
    op.drop_column("users", "oidc_subject")
    op.drop_column("users", "oidc_issuer")
    op.drop_column("targets", "allow_jev")
    op.drop_index(op.f("ix_targets_team_id"), table_name="targets")
    op.drop_constraint(op.f("fk_targets_team_id_teams"), "targets", type_="foreignkey")
    op.drop_column("targets", "team_id")
    op.drop_index("ix_audit_events_subject_type_subject_id", table_name="audit_events")
    op.drop_index("ix_audit_events_created_at", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_traffic_probe_results_bucket_hour", table_name="traffic_probe_results")
    op.drop_table("traffic_probe_results")
    op.drop_table("team_budgets")
    op.drop_index(op.f("ix_team_members_user_id"), table_name="team_members")
    op.drop_table("team_members")
    op.drop_table("teams")
