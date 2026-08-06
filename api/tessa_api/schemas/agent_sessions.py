from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from tessa_api.schemas.common import Timestamp

CLAUDE_SESSION_ID_MAX_LENGTH = 100
CWD_LABEL_MAX_LENGTH = 120
PLUGIN_VERSION_MAX_LENGTH = 40
SESSION_SUMMARY_MAX_LENGTH = 2000


class AgentSessionCreate(BaseModel):
    claude_session_id: str = Field(
        min_length=1,
        max_length=CLAUDE_SESSION_ID_MAX_LENGTH,
        description="id of the Claude Code session; a second create with the id of a session "
        "that is still open returns that session",
    )
    target_id: UUID | None = Field(
        default=None, description="target the session works on, when it already knows"
    )
    cwd_label: str = Field(
        min_length=1,
        max_length=CWD_LABEL_MAX_LENGTH,
        description="name of the working folder, never a full path",
    )
    plugin_version: str = Field(min_length=1, max_length=PLUGIN_VERSION_MAX_LENGTH)

    @field_validator("claude_session_id", "cwd_label", "plugin_version")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class AgentSessionUpdate(BaseModel):
    target_id: UUID | None = Field(
        default=None, description="new target of the session; an explicit null clears it"
    )
    ended_at: Timestamp | None = Field(
        default=None,
        description="when the session ended, with a UTC offset; Tessa clamps it between the "
        "start of the session and now, so a skewed clock never loses the end, and the first "
        "value sticks",
    )
    summary: str | None = Field(
        default=None,
        max_length=SESSION_SUMMARY_MAX_LENGTH,
        description="what the session did, written by the plugin when the session stops",
    )


class AgentSession(BaseModel):
    id: UUID
    user_id: UUID
    user_name: str
    target_id: UUID | None
    claude_session_id: str
    cwd_label: str
    plugin_version: str
    started_at: Timestamp
    ended_at: Timestamp | None
    summary: str | None
    write_count: int = Field(
        ge=0, description="writes made with a personal token while the session was open"
    )
    active: bool = Field(
        description="true while the session has not ended and started less than twelve hours ago"
    )


class AgentSessionPage(BaseModel):
    items: list[AgentSession]
    next_cursor: str | None
    total: int | None
