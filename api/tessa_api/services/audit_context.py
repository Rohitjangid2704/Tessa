import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from enum import StrEnum

from tessa_api.schemas.enums import AuditVia


class AuthKind(StrEnum):
    session = "session"
    personal = "personal"
    service = "service"


@dataclass(slots=True)
class AuditContext:
    auth_kind: AuthKind = AuthKind.session
    via: AuditVia = AuditVia.web
    user_id: uuid.UUID | None = None
    token_id: uuid.UUID | None = None
    agent_session_id: uuid.UUID | None = None

    def mark_session(self, user_id: uuid.UUID) -> None:
        self.auth_kind = AuthKind.session
        self.via = AuditVia.web
        self.user_id = user_id
        self.token_id = None
        self.agent_session_id = None

    def mark_personal(
        self, user_id: uuid.UUID, token_id: uuid.UUID, agent_session_id: uuid.UUID | None
    ) -> None:
        self.auth_kind = AuthKind.personal
        self.via = AuditVia.mcp
        self.user_id = user_id
        self.token_id = token_id
        self.agent_session_id = agent_session_id

    def mark_service(self) -> None:
        self.auth_kind = AuthKind.service
        self.via = AuditVia.svc
        self.user_id = None
        self.token_id = None
        self.agent_session_id = None


audit_context_var: ContextVar[AuditContext | None] = ContextVar("audit_context", default=None)


def current_audit_context() -> AuditContext:
    context = audit_context_var.get()
    return context if context is not None else AuditContext()
