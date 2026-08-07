import asyncio
import logging
from typing import Protocol

logger = logging.getLogger("tessa_api.retention")

SETUP_ATTEMPTS = 5
SETUP_RETRY_SECONDS = 20.0
SETUP_DEADLINE_SECONDS = 180.0


class RetentionScheduleGateway(Protocol):
    async def ensure_retention_sweep_schedule(self) -> bool: ...


async def setup_retention_schedule(gateway: RetentionScheduleGateway) -> None:
    for attempt in range(1, SETUP_ATTEMPTS + 1):
        try:
            created = await gateway.ensure_retention_sweep_schedule()
        except Exception as error:
            logger.warning(
                "retention_schedule_not_ready",
                extra={"attempt": attempt, "error": type(error).__name__},
            )
            if attempt < SETUP_ATTEMPTS:
                await asyncio.sleep(SETUP_RETRY_SECONDS)
            continue
        logger.info("retention_schedule_ready", extra={"schedule_created": created})
        return
    logger.error("retention_schedule_failed", extra={"attempts": SETUP_ATTEMPTS})


async def run_retention_schedule_setup(gateway: RetentionScheduleGateway) -> None:
    try:
        async with asyncio.timeout(SETUP_DEADLINE_SECONDS):
            await setup_retention_schedule(gateway)
    except TimeoutError:
        logger.warning("retention_schedule_timed_out")
    except Exception:
        logger.exception("retention_schedule_setup_failed")
