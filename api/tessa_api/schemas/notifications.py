import re
from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field, StringConstraints

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import NotificationKind, Severity

NOTIFICATION_TITLE_MAX_LENGTH = 200
NOTIFICATION_BODY_MAX_LENGTH = 4000
NOTIFICATION_LINK_MAX_LENGTH = 500
EMAIL_ADDRESS_MAX_LENGTH = 254
EMAIL_ADDRESS_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
UNSAFE_LINK_CHARACTERS = re.compile(r"[\s\\\x00-\x1f\x7f]")


def require_relative_app_path(value: str) -> str:
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("must be a relative app path with a single leading slash")
    if UNSAFE_LINK_CHARACTERS.search(value):
        raise ValueError("must not contain whitespace, control characters or backslashes")
    return value


RelativeAppPath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=NOTIFICATION_LINK_MAX_LENGTH),
    AfterValidator(require_relative_app_path),
]
EmailAddress = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=3,
        max_length=EMAIL_ADDRESS_MAX_LENGTH,
        pattern=EMAIL_ADDRESS_PATTERN,
    ),
]
NotificationTitle = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=NOTIFICATION_TITLE_MAX_LENGTH
    ),
]


class Notification(BaseModel):
    id: UUID
    kind: NotificationKind
    severity: Severity
    title: str
    body: str
    link: RelativeAppPath = Field(
        description="relative app path with a single leading slash, never an absolute URL"
    )
    run_id: UUID | None
    read_at: Timestamp | None
    created_at: Timestamp


class NotificationPage(BaseModel):
    items: list[Notification]
    next_cursor: str | None
    total: int | None


class NotificationContent(BaseModel):
    kind: NotificationKind
    severity: Severity
    title: NotificationTitle
    body: str = Field(
        default="",
        max_length=NOTIFICATION_BODY_MAX_LENGTH,
        description="plain text detail shown under the title; empty when the title says it all",
    )
    link: RelativeAppPath = Field(
        description="relative app path to the page that explains the notification"
    )
    run_id: UUID | None = Field(
        default=None,
        description="run the notification is about; with the kind it makes the notification unique",
    )


class NotificationDraft(NotificationContent):
    user_id: UUID | None = Field(
        default=None, description="recipient; null broadcasts to every user"
    )
