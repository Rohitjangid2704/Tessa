import logging
from collections.abc import Callable

import httpx
from sqlalchemy.exc import IntegrityError
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.notifications import Notification, NotificationDraft
from tessa_api.schemas.temporal import (
    CREATE_NOTIFICATION_ACTIVITY,
    SEND_SLACK_ACTIVITY,
    ChannelSendResult,
    CreateNotificationInput,
    CreateNotificationResult,
    SlackMessage,
)
from tessa_api.services.channel_delivery import ChannelDeliveryError, post_slack
from tessa_api.services.notification_channels import resolve_slack_webhook
from tessa_api.services.notifications import create_notification_row, notification_events
from tessa_api.services.run_notifications import plan_run_notifications
from tessa_api.services.vault import Vault, VaultError
from tessa_worker.activities.notify_models import (
    EVALUATE_NOTIFICATIONS,
    EvaluateNotificationsInput,
    EvaluateNotificationsResult,
)
from tessa_worker.activities.scenarios import api_errors_as_application_errors
from tessa_worker.activities.tier0 import permanent
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.notify")

HttpFactory = Callable[[], httpx.AsyncClient]


def default_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(follow_redirects=False)


class WorkerNotificationEvents:
    def __init__(self, client: EventClient) -> None:
        self.client = client

    async def created(self, notification: Notification) -> None:
        await self.client.deliver(notification_events(notification))


def delivery_outcome(channel: str, error: ChannelDeliveryError) -> ChannelSendResult:
    if error.retryable:
        raise ApplicationError(error.message)
    logger.warning("channel_not_sent", extra={"channel": channel, "cause": error.message})
    return ChannelSendResult(ok=False)


class NotifyActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        vault: Vault,
        http_factory: HttpFactory = default_http_client,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = WorkerNotificationEvents(events)
        self.vault = vault
        self.http_factory = http_factory

    @activity.defn(name=CREATE_NOTIFICATION_ACTIVITY)
    async def create_notification(
        self, request: CreateNotificationInput
    ) -> CreateNotificationResult:
        draft = NotificationDraft.model_validate({**request.model_dump(), "user_id": None})
        try:
            async with self.session_factory() as session:
                write = await create_notification_row(session, draft, self.events)
        except IntegrityError:
            raise permanent(
                "the notification could not be stored; its run no longer exists"
            ) from None
        return CreateNotificationResult(
            notification_id=write.notification.id, created=write.created
        )

    @activity.defn(name=EVALUATE_NOTIFICATIONS)
    async def evaluate_notifications(
        self, request: EvaluateNotificationsInput
    ) -> EvaluateNotificationsResult:
        with api_errors_as_application_errors():
            async with self.session_factory() as session:
                planned = await plan_run_notifications(
                    session, self.vault, self.settings, request.run_id, request.channels
                )
        return EvaluateNotificationsResult(notifications=planned)

    @activity.defn(name=SEND_SLACK_ACTIVITY)
    async def send_slack(self, request: SlackMessage) -> ChannelSendResult:
        try:
            async with self.session_factory() as session:
                webhook = await resolve_slack_webhook(session, self.vault, self.settings)
        except VaultError:
            logger.warning("slack_webhook_unreadable")
            return ChannelSendResult(ok=False)
        if webhook is None:
            return ChannelSendResult(ok=False)
        try:
            async with self.http_factory() as client:
                await post_slack(client, webhook, request.text, request.link)
        except ChannelDeliveryError as error:
            return delivery_outcome("slack", error)
        return ChannelSendResult(ok=True)
