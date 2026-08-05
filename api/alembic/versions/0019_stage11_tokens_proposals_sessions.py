from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_JSON_ARRAY = sa.text("'[]'::jsonb")
NOW = sa.text("now()")
ZERO = sa.text("0")
WEB_VIA = sa.text("'web'")


def jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def timestamp(name: str, nullable: bool = False, default_now: bool = False) -> sa.Column[Any]:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=NOW if default_now else None,
        nullable=nullable,
    )


def create_personal_tokens() -> None:
    op.create_table(
        "personal_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("prefix", sa.Text(), nullable=False),
        timestamp("created_at", default_now=True),
        timestamp("expires_at"),
        timestamp("last_used_at", nullable=True),
        timestamp("revoked_at", nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_personal_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_personal_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_personal_tokens_token_hash")),
    )
    op.create_index(
        op.f("ix_personal_tokens_user_id"), "personal_tokens", ["user_id"], unique=False
    )


def create_agent_sessions() -> None:
    op.create_table(
        "agent_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=True),
        sa.Column("claude_session_id", sa.Text(), nullable=False),
        sa.Column("cwd_label", sa.Text(), nullable=False),
        sa.Column("plugin_version", sa.Text(), nullable=False),
        timestamp("started_at", default_now=True),
        timestamp("ended_at", nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("write_count", sa.Integer(), server_default=ZERO, nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_agent_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["target_id"],
            ["targets.id"],
            name=op.f("fk_agent_sessions_target_id_targets"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_sessions")),
    )
    op.create_index(
        "ix_agent_sessions_target_id_started_at",
        "agent_sessions",
        ["target_id", sa.text("started_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_agent_sessions_user_id_claude_session_id",
        "agent_sessions",
        ["user_id", "claude_session_id"],
        unique=False,
    )


def create_proposals() -> None:
    op.create_table(
        "proposals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("target_id", sa.Uuid(), nullable=False),
        sa.Column("bundle_id", sa.Uuid(), nullable=True),
        sa.Column("prompt_issue_id", sa.Uuid(), nullable=True),
        sa.Column("commit_sha", sa.Text(), nullable=True),
        sa.Column("branch", sa.Text(), nullable=True),
        timestamp("generated_at"),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        timestamp("created_at", default_now=True),
        sa.ForeignKeyConstraint(
            ["target_id"],
            ["targets.id"],
            name=op.f("fk_proposals_target_id_targets"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["bundle_id"],
            ["bundles.id"],
            name=op.f("fk_proposals_bundle_id_bundles"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["prompt_issue_id"],
            ["prompt_issues.id"],
            name=op.f("fk_proposals_prompt_issue_id_prompt_issues"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_proposals_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_proposals")),
    )
    op.create_index(
        "ix_proposals_target_id_created_at",
        "proposals",
        ["target_id", sa.text("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "proposal_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("proposal_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("area", sa.Text(), nullable=False),
        sa.Column("feature_ids", jsonb(), nullable=False),
        sa.Column("interface_id", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("risk", sa.Text(), nullable=False),
        sa.Column("reasons", jsonb(), nullable=False),
        sa.Column("needs", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.Column("depth", sa.Text(), nullable=False),
        sa.Column("estimate", jsonb(), nullable=True),
        sa.Column("confidence", sa.Text(), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("selected_by", sa.Uuid(), nullable=True),
        timestamp("selected_at", nullable=True),
        sa.Column("scenario_ids", jsonb(), server_default=EMPTY_JSON_ARRAY, nullable=False),
        sa.ForeignKeyConstraint(
            ["proposal_id"],
            ["proposals.id"],
            name=op.f("fk_proposal_items_proposal_id_proposals"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["selected_by"],
            ["users.id"],
            name=op.f("fk_proposal_items_selected_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_proposal_items")),
        sa.UniqueConstraint("proposal_id", "key", name=op.f("uq_proposal_items_proposal_id_key")),
    )


def add_columns_to_earlier_tables() -> None:
    op.add_column("explanations", sa.Column("structured", jsonb(), nullable=True))
    op.add_column("bundles", sa.Column("commit_sha", sa.Text(), nullable=True))
    op.add_column("bundles", sa.Column("branch", sa.Text(), nullable=True))
    op.add_column(
        "audit_events",
        sa.Column("via", sa.Text(), server_default=WEB_VIA, nullable=False),
    )
    op.add_column("audit_events", sa.Column("agent_session_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_audit_events_agent_session_id_agent_sessions"),
        "audit_events",
        "agent_sessions",
        ["agent_session_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_audit_events_agent_session_id", "audit_events", ["agent_session_id"], unique=False
    )


def upgrade() -> None:
    create_personal_tokens()
    create_agent_sessions()
    create_proposals()
    add_columns_to_earlier_tables()


def downgrade() -> None:
    op.drop_index("ix_audit_events_agent_session_id", table_name="audit_events")
    op.drop_constraint(
        op.f("fk_audit_events_agent_session_id_agent_sessions"),
        "audit_events",
        type_="foreignkey",
    )
    op.drop_column("audit_events", "agent_session_id")
    op.drop_column("audit_events", "via")
    op.drop_column("bundles", "branch")
    op.drop_column("bundles", "commit_sha")
    op.drop_column("explanations", "structured")
    op.drop_table("proposal_items")
    op.drop_index("ix_proposals_target_id_created_at", table_name="proposals")
    op.drop_table("proposals")
    op.drop_index("ix_agent_sessions_user_id_claude_session_id", table_name="agent_sessions")
    op.drop_index("ix_agent_sessions_target_id_started_at", table_name="agent_sessions")
    op.drop_table("agent_sessions")
    op.drop_index(op.f("ix_personal_tokens_user_id"), table_name="personal_tokens")
    op.drop_table("personal_tokens")
