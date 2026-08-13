from uuid import UUID

from tessa_worker.adapters.browser_session.session import ExplorerSession
from tessa_worker.lab.contracts import SessionHandle


class InProcessSessionRegistry:
    def __init__(self) -> None:
        self.sessions: dict[UUID, ExplorerSession] = {}

    def add(self, handle: SessionHandle) -> None:
        if not isinstance(handle, ExplorerSession):
            raise TypeError("only explorer sessions are registered")
        self.sessions[handle.browser_session_id] = handle

    def get(self, browser_session_id: UUID) -> ExplorerSession | None:
        return self.sessions.get(browser_session_id)

    def remove(self, browser_session_id: UUID) -> ExplorerSession | None:
        return self.sessions.pop(browser_session_id, None)

    def open_ids(self) -> frozenset[UUID]:
        return frozenset(self.sessions)

    def idle_ids(self, limit_seconds: float) -> list[UUID]:
        return [
            session_id
            for session_id, session in self.sessions.items()
            if session.idle_seconds() > limit_seconds
        ]
