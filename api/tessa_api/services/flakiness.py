from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from tessa_api.schemas.common import Timestamp
from tessa_api.schemas.enums import VerdictStatus

FLAKINESS_KEY = "flakiness"
COUNTED_RUN_LIMIT = 20
DECIDED_STATUSES = frozenset({VerdictStatus.pass_, VerdictStatus.fail})


class RunOutcome(StrEnum):
    flaky = "flaky"
    steady = "steady"
    undecided = "undecided"


class FlakinessRecord(BaseModel):
    streak: int = Field(
        default=0, ge=0, description="consecutive runs in which the scenario was flaky"
    )
    counted_run_ids: list[str] = Field(
        default_factory=list,
        description="latest runs already counted, so a retry never counts twice",
    )
    quarantined_at: Timestamp | None = None
    released_at: Timestamp | None = None


@dataclass(frozen=True, slots=True)
class Advance:
    record: FlakinessRecord
    counted: bool
    quarantine: bool


def run_outcome(statuses: Iterable[VerdictStatus | None]) -> RunOutcome:
    seen = set(statuses)
    if VerdictStatus.flaky in seen:
        return RunOutcome.flaky
    if seen & DECIDED_STATUSES:
        return RunOutcome.steady
    return RunOutcome.undecided


def needs_counting(record: FlakinessRecord, outcome: RunOutcome) -> bool:
    return outcome is RunOutcome.flaky or (outcome is RunOutcome.steady and record.streak > 0)


def advance(
    record: FlakinessRecord, run_id: UUID, outcome: RunOutcome, quarantine_after: int
) -> Advance:
    key = str(run_id)
    if not needs_counting(record, outcome) or key in record.counted_run_ids:
        return Advance(record=record, counted=False, quarantine=False)
    is_flaky = outcome is RunOutcome.flaky
    streak = record.streak + 1 if is_flaky else 0
    updated = record.model_copy(
        update={
            "streak": streak,
            "counted_run_ids": [*record.counted_run_ids, key][-COUNTED_RUN_LIMIT:],
        }
    )
    return Advance(record=updated, counted=True, quarantine=is_flaky and streak >= quarantine_after)


def quarantined(record: FlakinessRecord, now: datetime) -> FlakinessRecord:
    return record.model_copy(update={"quarantined_at": now})


def released(record: FlakinessRecord, now: datetime) -> FlakinessRecord:
    return record.model_copy(update={"streak": 0, "quarantined_at": None, "released_at": now})


def record_of(provenance: Mapping[str, Any] | None) -> FlakinessRecord:
    raw = None if provenance is None else provenance.get(FLAKINESS_KEY)
    if raw is None:
        return FlakinessRecord()
    try:
        return FlakinessRecord.model_validate(raw)
    except ValidationError:
        return FlakinessRecord()


def provenance_with(
    provenance: Mapping[str, Any] | None, record: FlakinessRecord
) -> dict[str, Any]:
    return {**(provenance or {}), FLAKINESS_KEY: record.model_dump(mode="json")}


def provenance_after_release(provenance: Mapping[str, Any] | None, now: datetime) -> dict[str, Any]:
    return provenance_with(provenance, released(record_of(provenance), now))
