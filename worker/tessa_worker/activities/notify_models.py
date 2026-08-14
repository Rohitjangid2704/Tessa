from uuid import UUID

from pydantic import BaseModel, Field

from tessa_api.schemas.enums import ReportChannel
from tessa_api.schemas.notification_plans import PlannedNotification

EVALUATE_NOTIFICATIONS = "evaluate_notifications"


class EvaluateNotificationsInput(BaseModel):
    run_id: UUID
    channels: list[ReportChannel] = Field(
        description="channels the caller allows; the settings and the schedule narrow them"
    )


class EvaluateNotificationsResult(BaseModel):
    notifications: list[PlannedNotification] = Field(
        description="notifications that fire for the finished run, with the messages to send"
    )
