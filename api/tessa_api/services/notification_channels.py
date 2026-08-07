import logging
from dataclasses import dataclass

from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.schemas.enums import SecretName
from tessa_api.services.settings_service import (
    SLACK_ENABLED_PATH,
    load_overrides,
    resolve_secret,
)
from tessa_api.services.vault import Vault, VaultError
from tessa_api.settings import StrictSettings

logger = logging.getLogger("tessa_api.notifications")


@dataclass(frozen=True, slots=True)
class ChannelState:
    slack_ready: bool


async def resolve_slack_webhook(
    session: AsyncSession, vault: Vault, settings: StrictSettings
) -> SecretStr | None:
    return await resolve_secret(session, vault, settings, SecretName.slack_webhook_url)


async def webhook_if_readable(
    session: AsyncSession, vault: Vault, settings: StrictSettings
) -> SecretStr | None:
    try:
        return await resolve_slack_webhook(session, vault, settings)
    except VaultError:
        logger.warning("slack_webhook_unreadable")
        return None


async def resolve_channel_state(
    session: AsyncSession, vault: Vault, settings: StrictSettings
) -> ChannelState:
    overrides = await load_overrides(session)
    webhook = await webhook_if_readable(session, vault, settings)
    slack_enabled = bool(overrides.get(SLACK_ENABLED_PATH, True))
    return ChannelState(slack_ready=webhook is not None and slack_enabled)
