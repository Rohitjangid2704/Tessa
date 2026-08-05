from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0008_p4gr"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "steps",
        sa.Column("machine_grading", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute(
        "UPDATE steps SET machine_grading = jsonb_build_object("
        "'verdict', verdict, 'escalated_to', NULL, 'review_reasons', '[]'::jsonb) "
        "WHERE verdict IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("steps", "machine_grading")
