import re
import uuid
from collections.abc import Sequence
from typing import Any, TypeIs

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_ARRAY = sa.text("'[]'::jsonb")
EMPTY_NOTIFY = sa.text("""'{"slack": false, "email": []}'::jsonb""")
NOW = sa.text("now()")
ZERO = sa.text("0")
TRUE = sa.text("true")

PLAN_SCHEDULE_NAMESPACE = uuid.UUID("5d0c4f2e-8a1b-4c6d-9e7f-3a2b1c0d9e8f")
SCHEDULE_TIERS = ("commit", "nightly", "weekly")
COMMIT_TIER = "commit"
DEFAULT_TIER = "nightly"
DEFAULT_TIMEZONE = "UTC"
MAX_NOTIFY_EMAILS = 20
EMAIL_ADDRESS = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def jsonb(none_as_null: bool = False) -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text(), none_as_null=none_as_null)


def timestamp(name: str, nullable: bool = False, default_now: bool = False) -> sa.Column[Any]:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=NOW if default_now else None,
        nullable=nullable,
    )


def create_mutants() -> None:
    op.create_table(
        "mutants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("branch", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("expected_catchers", jsonb(), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=True),
        sa.Column("deployed_marker", jsonb(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("last_outcome", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["target_id"], ["targets.id"], name=op.f("fk_mutants_target_id_targets")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_mutants_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mutants")),
        sa.UniqueConstraint("target_id", "name", name=op.f("uq_mutants_target_id_name")),
    )
    op.create_index(
        "ix_mutants_target_id_created_at",
        "mutants",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )


def create_mutation_runs() -> None:
    op.create_table(
        "mutation_runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("mutant_id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("baseline_run_id", sa.Uuid(), nullable=True),
        sa.Column("outcomes", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.Column("power", sa.Numeric(8, 6), nullable=True),
        timestamp("started_at", default_now=True),
        timestamp("finished_at", nullable=True),
        sa.ForeignKeyConstraint(
            ["run_id"], ["runs.id"], name=op.f("fk_mutation_runs_run_id_runs"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["mutant_id"],
            ["mutants.id"],
            name=op.f("fk_mutation_runs_mutant_id_mutants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["plan_id"],
            ["plans.id"],
            name=op.f("fk_mutation_runs_plan_id_plans"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["baseline_run_id"],
            ["runs.id"],
            name=op.f("fk_mutation_runs_baseline_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mutation_runs")),
        sa.UniqueConstraint("run_id", name=op.f("uq_mutation_runs_run_id")),
    )
    op.create_index(
        "ix_mutation_runs_mutant_id_started_at",
        "mutation_runs",
        ["mutant_id", sa.text("started_at DESC")],
        unique=False,
    )


def create_schedules() -> None:
    op.create_table(
        "schedules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("plan_id", sa.Uuid(), nullable=False),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column("cron", sa.Text(), nullable=True),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=TRUE, nullable=False),
        sa.Column("budget", jsonb(), nullable=True),
        sa.Column("temporal_schedule_id", sa.Text(), nullable=False),
        sa.Column("notify", jsonb(), server_default=EMPTY_NOTIFY, nullable=False),
        sa.Column("last_run_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["plan_id"], ["plans.id"], name=op.f("fk_schedules_plan_id_plans"), ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["last_run_id"],
            ["runs.id"],
            name=op.f("fk_schedules_last_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_schedules_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_schedules")),
        sa.UniqueConstraint("temporal_schedule_id", name=op.f("uq_schedules_temporal_schedule_id")),
    )
    op.create_index("ix_schedules_plan_id", "schedules", ["plan_id"], unique=False)


def create_notifications() -> None:
    op.create_table(
        "notifications",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), server_default="", nullable=False),
        sa.Column("link", sa.Text(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        timestamp("read_at", nullable=True),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_notifications_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["runs.id"],
            name=op.f("fk_notifications_run_id_runs"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notifications")),
    )
    op.create_index(
        "ix_notifications_user_id_read_at", "notifications", ["user_id", "read_at"], unique=False
    )
    op.create_index(
        "uq_notifications_kind_run_id",
        "notifications",
        ["kind", "run_id"],
        unique=True,
        postgresql_where=sa.text("run_id IS NOT NULL"),
    )


def is_number(value: Any) -> TypeIs[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


def clean_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def migrated_budget(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    max_usd, max_minutes = value.get("max_usd"), value.get("max_minutes")
    if not is_number(max_usd) or not is_number(max_minutes):
        return None
    if max_usd < 0 or max_minutes < 1:
        return None
    return {"max_usd": float(max_usd), "max_minutes": int(max_minutes)}


def migrated_notify(value: Any) -> dict[str, Any]:
    notify = value if isinstance(value, dict) else {}
    emails = notify.get("email")
    addresses = (
        [
            address.strip()
            for address in emails
            if isinstance(address, str) and EMAIL_ADDRESS.match(address.strip())
        ]
        if isinstance(emails, list)
        else []
    )
    return {"slack": notify.get("slack") is True, "email": addresses[:MAX_NOTIFY_EMAILS]}


def migrated_schedule(row: sa.RowMapping) -> dict[str, Any]:
    blob = row["schedule"] if isinstance(row["schedule"], dict) else {}
    tier = blob.get("tier") if blob.get("tier") in SCHEDULE_TIERS else DEFAULT_TIER
    cron = None if tier == COMMIT_TIER else clean_text(blob.get("cron"))
    enabled = blob["enabled"] if isinstance(blob.get("enabled"), bool) else True
    schedule_id = uuid.uuid5(PLAN_SCHEDULE_NAMESPACE, str(row["id"]))
    return {
        "id": schedule_id,
        "plan_id": row["id"],
        "tier": tier,
        "cron": cron,
        "timezone": clean_text(blob.get("timezone")) or DEFAULT_TIMEZONE,
        "enabled": enabled and (tier == COMMIT_TIER or cron is not None),
        "budget": migrated_budget(blob.get("budget")),
        "temporal_schedule_id": f"schedule-{schedule_id}",
        "notify": migrated_notify(blob.get("notify")),
        "last_run_id": None,
        "created_by": row["created_by"],
        "created_at": row["created_at"],
    }


def convert_plan_schedules() -> None:
    existing = sa.text(
        "SELECT id, schedule, created_by, created_at FROM plans WHERE schedule IS NOT NULL"
    ).columns(
        sa.column("id", sa.Uuid()),
        sa.column("schedule", jsonb()),
        sa.column("created_by", sa.Uuid()),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    rows = op.get_bind().execute(existing).mappings().all()
    if not rows:
        return
    schedules = sa.table(
        "schedules",
        sa.column("id", sa.Uuid()),
        sa.column("plan_id", sa.Uuid()),
        sa.column("tier", sa.Text()),
        sa.column("cron", sa.Text()),
        sa.column("timezone", sa.Text()),
        sa.column("enabled", sa.Boolean()),
        sa.column("budget", jsonb(none_as_null=True)),
        sa.column("temporal_schedule_id", sa.Text()),
        sa.column("notify", jsonb()),
        sa.column("last_run_id", sa.Uuid()),
        sa.column("created_by", sa.Uuid()),
        sa.column("created_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(schedules, [migrated_schedule(row) for row in rows])
    op.execute(
        "UPDATE plans SET schedule_id = schedules.id FROM schedules "
        "WHERE schedules.plan_id = plans.id"
    )


def restore_plan_schedules() -> None:
    op.execute(
        "UPDATE plans SET schedule = jsonb_build_object("
        "'tier', schedules.tier, 'cron', schedules.cron, 'timezone', schedules.timezone, "
        "'enabled', schedules.enabled, 'budget', schedules.budget, 'notify', schedules.notify) "
        "FROM schedules WHERE plans.schedule_id = schedules.id"
    )


def upgrade() -> None:
    create_mutants()
    create_mutation_runs()
    create_schedules()
    create_notifications()
    op.add_column("plans", sa.Column("schedule_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_plans_schedule_id_schedules"),
        "plans",
        "schedules",
        ["schedule_id"],
        ["id"],
        ondelete="SET NULL",
    )
    convert_plan_schedules()
    op.drop_column("plans", "schedule")
    op.add_column(
        "bundles",
        sa.Column("mutants_imported", sa.Integer(), server_default=ZERO, nullable=False),
    )


def downgrade() -> None:
    op.drop_column("bundles", "mutants_imported")
    op.add_column("plans", sa.Column("schedule", jsonb(), nullable=True))
    restore_plan_schedules()
    op.drop_constraint(op.f("fk_plans_schedule_id_schedules"), "plans", type_="foreignkey")
    op.drop_column("plans", "schedule_id")
    op.drop_index("uq_notifications_kind_run_id", table_name="notifications")
    op.drop_index("ix_notifications_user_id_read_at", table_name="notifications")
    op.drop_table("notifications")
    op.drop_index("ix_schedules_plan_id", table_name="schedules")
    op.drop_table("schedules")
    op.drop_index("ix_mutation_runs_mutant_id_started_at", table_name="mutation_runs")
    op.drop_table("mutation_runs")
    op.drop_index("ix_mutants_target_id_created_at", table_name="mutants")
    op.drop_table("mutants")
