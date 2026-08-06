from pydantic import BaseModel, Field

from tessa_api.schemas.notifications import NotificationContent
from tessa_api.schemas.temporal import SlackMessage


class PlannedNotification(BaseModel):
    content: NotificationContent = Field(description="the in-app notification to store")
    slack: SlackMessage | None = Field(
        default=None, description="the Slack message to send once the notification is new"
    )
