from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.runs import ClockSnapshot
from tessa_api.schemas.temporal import RESOLVE_CLOCK_ACTIVITY, ResolveClockInput
from tessa_api.services.vault import vault_from_settings
from tessa_worker.adapters.registry import default_registry
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.clock import ClockPinError, ClockResolver

CLOCK_PIN_FAILED = "clock_pin_failed"


class ClockActivities:
    def __init__(self, resolver: ClockResolver) -> None:
        self.resolver = resolver

    @activity.defn(name=RESOLVE_CLOCK_ACTIVITY)
    async def resolve_clock(self, request: ResolveClockInput) -> ClockSnapshot:
        try:
            return await self.resolver.resolve(request.target_id, request.bundle_id)
        except ClockPinError as error:
            raise ApplicationError(
                error.message, type=CLOCK_PIN_FAILED, non_retryable=not error.retryable
            ) from None


def default_clock_activities(
    settings: WorkerSettings, session_factory: SessionFactory
) -> ClockActivities:
    resolver = ClockResolver(
        session_factory, vault_from_settings(settings), default_registry(), settings
    )
    return ClockActivities(resolver)
