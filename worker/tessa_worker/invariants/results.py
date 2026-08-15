import uuid
from datetime import UTC, datetime

from tessa_api.db.models import InvariantResultRow
from tessa_api.schemas.enums import InvariantPack, SkipReason, VerdictStatus, VerdictTier
from tessa_api.schemas.invariants import InvariantResult
from tessa_api.schemas.streams import IngestEvent, InvariantResultPayload
from tessa_worker.event_client import build_event

INVARIANT_RESULT_EVENT = "invariant.result"
RESULT_NAMESPACE = uuid.UUID("6f1c3a52-8d0e-4b7a-9c21-5e4a7b0d3f18")
NO_VALUE = "-"


def result_row_id(
    run_id: uuid.UUID,
    run_scenario_id: uuid.UUID | None,
    attempt: int | None,
    invariant_id: str,
    ordinal: int,
) -> uuid.UUID:
    parts = (
        str(run_id),
        NO_VALUE if run_scenario_id is None else str(run_scenario_id),
        NO_VALUE if attempt is None else str(attempt),
        invariant_id,
        str(ordinal),
    )
    return uuid.uuid5(RESULT_NAMESPACE, ":".join(parts))


def new_result_row(
    *,
    run_id: uuid.UUID,
    run_scenario_id: uuid.UUID | None,
    step_id: uuid.UUID | None,
    attempt: int | None,
    invariant_id: str,
    pack: InvariantPack,
    status: VerdictStatus,
    tier: VerdictTier,
    confidence: float | None,
    message: str,
    skip_reason: SkipReason | None,
    ordinal: int,
) -> InvariantResultRow:
    return InvariantResultRow(
        id=result_row_id(run_id, run_scenario_id, attempt, invariant_id, ordinal),
        run_id=run_id,
        run_scenario_id=run_scenario_id,
        step_id=step_id,
        attempt=attempt,
        invariant_id=invariant_id,
        pack=pack,
        status=status,
        tier=tier,
        confidence=confidence,
        message=message,
        skip_reason=skip_reason,
        created_at=datetime.now(UTC),
    )


def to_invariant_result(row: InvariantResultRow) -> InvariantResult:
    return InvariantResult.model_validate(row, from_attributes=True)


def result_event(row: InvariantResultRow) -> IngestEvent:
    return build_event(
        row.run_id,
        INVARIANT_RESULT_EVENT,
        InvariantResultPayload(
            invariant_id=row.invariant_id,
            pack=row.pack,
            run_scenario_id=row.run_scenario_id,
            attempt=row.attempt,
            status=row.status,
            tier=row.tier,
            message=row.message,
            skip_reason=row.skip_reason,
        ),
        f"{INVARIANT_RESULT_EVENT}:{row.id}",
    )
