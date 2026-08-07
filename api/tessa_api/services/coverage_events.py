import logging
import uuid
from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import CoverageUpdateReason, ScenarioStatus
from tessa_api.schemas.streams import (
    CoverageUpdatedPayload,
    IngestEvent,
    ScenarioChangedPayload,
)
from tessa_api.services.cell_status import CellChange
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events

logger = logging.getLogger("tessa_api.coverage")

SCENARIO_CHANGED = "scenario.changed"
COVERAGE_UPDATED = "coverage.updated"


def scenario_changed_event(
    scenario_id: uuid.UUID, status: ScenarioStatus, cell_id: uuid.UUID | None
) -> IngestEvent:
    payload = ScenarioChangedPayload(scenario_id=scenario_id, status=status, cell_id=cell_id)
    return IngestEvent(
        type=SCENARIO_CHANGED,
        payload=payload.model_dump(mode="json"),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def coverage_updated_events(
    changes: Sequence[CellChange], reason: CoverageUpdateReason
) -> list[IngestEvent]:
    grouped: dict[tuple[uuid.UUID, uuid.UUID], list[uuid.UUID]] = defaultdict(list)
    for change in changes:
        grouped[(change.target_id, change.plan_id)].append(change.cell_id)
    occurred_at = datetime.now(UTC)
    return [
        IngestEvent(
            type=COVERAGE_UPDATED,
            payload=CoverageUpdatedPayload(
                target_id=target_id, plan_id=plan_id, cell_ids=cell_ids, reason=reason
            ).model_dump(mode="json"),
            occurred_at=occurred_at,
            ephemeral=True,
        )
        for (target_id, plan_id), cell_ids in grouped.items()
    ]


async def publish_coverage_events(
    session_factory: SessionFactory, hub: Hub, events: Sequence[IngestEvent]
) -> None:
    if not events:
        return
    try:
        await append_events(session_factory, hub, events)
    except Exception:
        logger.exception(
            "coverage_events_not_published", extra={"events": [event.type for event in events]}
        )
