from uuid import UUID

from pydantic import BaseModel, Field, JsonValue

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import AuditAction, AuditSubjectType, AuditVia

AuditDetail = dict[str, JsonValue]


class AuditEventRecord(BaseModel):
    id: UUID
    actor_user_id: UUID | None = Field(
        description="user who made the change; null for system changes"
    )
    action: AuditAction
    subject_type: AuditSubjectType
    subject_id: UUID | None = Field(
        description="id of the changed user, team, target, token or proposal item, or of the "
        "resource a personal token wrote; null for secrets and retention"
    )
    detail: AuditDetail = Field(
        description="what changed, before and after; never a secret value or a password"
    )
    created_at: Timestamp


class AuditEvent(AuditEventRecord):
    via: AuditVia = Field(
        description="how the change reached the API: web for a browser session, mcp for a "
        "personal token, svc for the service key"
    )
    agent_session_id: UUID | None = Field(
        description="Claude Code session that made the change; set for personal tokens that "
        "sent X-Agent-Session"
    )


class AuditEventPage(BaseModel):
    items: list[AuditEvent]
    next_cursor: str | None
    total: int | None
