from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.temporal import (
    APPLY_FLAKINESS_POLICY_ACTIVITY,
    ApplyFlakinessPolicyInput,
    ApplyFlakinessPolicyResult,
)
from tessa_api.services.dashboard_events import dashboard_invalidate_event
from tessa_api.services.flakiness_policy import RunMissingError, apply_flakiness_policy
from tessa_api.services.settings_service import effective_settings
from tessa_worker.activities.tier0 import permanent
from tessa_worker.event_client import EventClient
from tessa_worker.settings import WorkerSettings


class FlakinessActivities:
    def __init__(
        self, settings: WorkerSettings, session_factory: SessionFactory, events: EventClient
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events

    @activity.defn(name=APPLY_FLAKINESS_POLICY_ACTIVITY)
    async def apply_flakiness_policy(
        self, request: ApplyFlakinessPolicyInput
    ) -> ApplyFlakinessPolicyResult:
        async with self.session_factory() as session:
            effective = await effective_settings(session, self.settings)
            try:
                outcome = await apply_flakiness_policy(
                    session, request.run_id, effective.flaky_quarantine_after
                )
            except RunMissingError as error:
                raise permanent(str(error)) from None
            await session.commit()
        await self.events.deliver_all([*outcome.events, dashboard_invalidate_event()])
        return ApplyFlakinessPolicyResult(
            quarantined=list(outcome.quarantined), findings=list(outcome.finding_ids)
        )
