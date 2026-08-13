from collections.abc import Mapping
from enum import StrEnum

CLOSE_NORMAL = 1000
CLOSE_GOING_AWAY = 1001
CLOSE_PROTOCOL_ERROR = 1002
CLOSE_UNSUPPORTED_DATA = 1003
CLOSE_NO_STATUS = 1005
CLOSE_ABNORMAL = 1006
CLOSE_INVALID_PAYLOAD = 1007
CLOSE_POLICY_VIOLATION = 1008
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_MANDATORY_EXTENSION = 1010
CLOSE_INTERNAL_ERROR = 1011
CLOSE_SERVICE_RESTART = 1012
CLOSE_TRY_AGAIN_LATER = 1013
CLOSE_BAD_GATEWAY = 1014
CLOSE_TLS_FAILURE = 1015


class CloseClass(StrEnum):
    ok = "ok"
    policy_violation = "policy_violation"
    server_error = "server_error"
    error = "error"


CLOSE_CLASSES: Mapping[int, CloseClass] = {
    CLOSE_NORMAL: CloseClass.ok,
    CLOSE_GOING_AWAY: CloseClass.ok,
    CLOSE_POLICY_VIOLATION: CloseClass.policy_violation,
    CLOSE_INTERNAL_ERROR: CloseClass.server_error,
}

ACCEPTED_CLOSE_CODES_BY_DEFAULT = frozenset({CLOSE_NORMAL, CLOSE_GOING_AWAY})

CLOSE_NAMES: Mapping[int, str] = {
    CLOSE_NORMAL: "normal closure",
    CLOSE_GOING_AWAY: "going away",
    CLOSE_PROTOCOL_ERROR: "protocol error",
    CLOSE_UNSUPPORTED_DATA: "unsupported data",
    CLOSE_NO_STATUS: "closed without a status code",
    CLOSE_ABNORMAL: "connection dropped without a close frame",
    CLOSE_INVALID_PAYLOAD: "invalid payload data",
    CLOSE_POLICY_VIOLATION: "policy violation",
    CLOSE_MESSAGE_TOO_BIG: "message too big",
    CLOSE_MANDATORY_EXTENSION: "mandatory extension missing",
    CLOSE_INTERNAL_ERROR: "internal server error",
    CLOSE_SERVICE_RESTART: "service restart",
    CLOSE_TRY_AGAIN_LATER: "try again later",
    CLOSE_BAD_GATEWAY: "bad gateway",
    CLOSE_TLS_FAILURE: "TLS handshake failure",
}


def classify_close(code: int) -> CloseClass:
    return CLOSE_CLASSES.get(code, CloseClass.error)


def describe_close(code: int, reason: str | None) -> str:
    name = CLOSE_NAMES.get(code, "application close code")
    suffix = f": {reason}" if reason else ""
    return f"{code} ({name}){suffix}"
