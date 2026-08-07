import uuid
from collections.abc import Mapping
from datetime import UTC, datetime

from pydantic import JsonValue

from tessa_api.db.models import FindingRow
from tessa_api.schemas.streams import (
    FindingChange,
    FindingCreatedPayload,
    FindingOccurrenceAddedPayload,
    FindingUpdatedPayload,
    IngestEvent,
)
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import event_envelope

FINDING_CREATED = "finding.created"
FINDING_UPDATED = "finding.updated"
FINDING_OCCURRENCE_ADDED = "finding.occurrence_added"


def created_dedupe_key(finding_id: uuid.UUID) -> str:
    return f"{FINDING_CREATED}:{finding_id}"


def created_event(run_id: uuid.UUID, row: FindingRow, is_new: bool) -> IngestEvent:
    payload = FindingCreatedPayload(
        finding_id=row.id,
        title=row.title,
        class_=row.class_,
        severity=row.severity,
        status=row.status,
        fingerprint=row.fingerprint,
        is_new=is_new,
        scenario_id=row.scenario_id,
    )
    return IngestEvent(
        run_id=run_id,
        type=FINDING_CREATED,
        payload=payload.model_dump(mode="json", by_alias=True),
        dedupe_key=created_dedupe_key(row.id),
        occurred_at=datetime.now(UTC),
    )


def occurrence_added_event(
    run_id: uuid.UUID, finding_id: uuid.UUID, occurrence_count: int
) -> IngestEvent:
    payload = FindingOccurrenceAddedPayload(
        finding_id=finding_id, run_id=run_id, occurrence_count=occurrence_count
    )
    return IngestEvent(
        run_id=run_id,
        type=FINDING_OCCURRENCE_ADDED,
        payload=payload.model_dump(mode="json", by_alias=True),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def updated_event(
    finding_id: uuid.UUID, changes: Mapping[str, tuple[JsonValue, JsonValue]]
) -> IngestEvent:
    payload = FindingUpdatedPayload(
        finding_id=finding_id,
        changes={
            name: FindingChange(from_=before, to=after) for name, (before, after) in changes.items()
        },
    )
    return IngestEvent(
        run_id=None,
        type=FINDING_UPDATED,
        payload=payload.model_dump(mode="json", by_alias=True),
        occurred_at=datetime.now(UTC),
        ephemeral=True,
    )


def publish_event(hub: Hub, event: IngestEvent) -> None:
    hub.publish_ephemeral(event_envelope(None, event))


def publish_updated(
    hub: Hub, finding_id: uuid.UUID, changes: Mapping[str, tuple[JsonValue, JsonValue]]
) -> None:
    if not changes:
        return
    publish_event(hub, updated_event(finding_id, changes))
