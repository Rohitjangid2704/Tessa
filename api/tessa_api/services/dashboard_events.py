from datetime import UTC, datetime

from tessa_api.schemas.streams import DashboardInvalidatePayload, IngestEvent
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import event_envelope

DASHBOARD_INVALIDATE = "dashboard.invalidate"


def dashboard_invalidate_event() -> IngestEvent:
    return IngestEvent(
        run_id=None,
        type=DASHBOARD_INVALIDATE,
        payload=DashboardInvalidatePayload().model_dump(mode="json"),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def publish_dashboard_invalidate(hub: Hub) -> None:
    hub.publish_ephemeral(event_envelope(None, dashboard_invalidate_event()))
