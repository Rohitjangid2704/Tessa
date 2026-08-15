import hashlib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunScenarioRow, ScenarioRow
from tessa_api.ids import new_id
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import (
    RunScenarioStatus,
    ScenarioOrigin,
    ScenarioStatus,
    SkipReason,
    SyntheticFamily,
)
from tessa_api.schemas.scenario import SCENARIO_SCHEMA_VERSION
from tessa_api.schemas.streams import IngestEvent, ScenarioQueuedPayload
from tessa_api.services.scenario_validator import ScenarioBundleView, validate_scenario_text
from tessa_api.services.smoke_generator import document_yaml
from tessa_worker.activities.scenario_lifecycle import finished_event
from tessa_worker.event_client import build_event
from tessa_worker.verdicts import skipped_verdict

FUZZ_FAMILY = SyntheticFamily.api_fuzz.value
FUZZ_GENERATOR = "api_fuzz"
HASH_KEY = "document_hash"
FUZZ_ATTEMPTS = 1
SCENARIO_QUEUED_EVENT = "scenario.queued"
REFRESHABLE_STATUSES = (ScenarioStatus.accepted, ScenarioStatus.invalid)


@dataclass(frozen=True, slots=True)
class StoredFuzzScenario:
    row: ScenarioRow
    role: str
    interface_id: str

    @property
    def runnable(self) -> bool:
        return self.row.status is ScenarioStatus.accepted

    def invalid_reason(self) -> str:
        errors = self.row.validation.get("errors") or []
        first = errors[0].get("message") if errors and isinstance(errors[0], dict) else None
        base = "the api fuzz scenario does not validate"
        return f"{base}: {first}" if first else base


@dataclass(frozen=True, slots=True)
class RunScenarioSlot:
    row: RunScenarioRow
    created: bool
    events: list[IngestEvent]


def fuzz_scenario_key(role: str, interface_id: str) -> str:
    return f"fuzz-{role}-{interface_id}"


def fuzz_document(role: str, interface_id: str) -> dict[str, Any]:
    return {
        "schema_version": SCENARIO_SCHEMA_VERSION,
        "id": fuzz_scenario_key(role, interface_id),
        "title": f"API fuzz as {role}",
        "family": FUZZ_FAMILY,
        "role": role,
        "interface_id": interface_id,
        "synthetic": True,
        "steps": [
            {
                "adapter": "http",
                "label": "Schemathesis against the OpenAPI document of the bundle",
                "request": {"method": "GET", "path": "/"},
            }
        ],
    }


def provenance_of(bundle: BundleRow, role: str, interface_id: str, digest: str) -> dict[str, Any]:
    return {
        "generator": FUZZ_GENERATOR,
        "role": role,
        "interface_id": interface_id,
        HASH_KEY: digest,
        "bundle_version": bundle.version,
    }


async def lock_fuzz_scenarios(session: AsyncSession, target_id: uuid.UUID) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"api-fuzz:{target_id}"},
    )


async def find_current(session: AsyncSession, target_id: uuid.UUID, key: str) -> ScenarioRow | None:
    return await session.scalar(
        select(ScenarioRow)
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.family == FUZZ_FAMILY,
            ScenarioRow.status != ScenarioStatus.retired,
            ScenarioRow.parsed["id"].astext == key,
        )
        .order_by(ScenarioRow.created_at.desc(), ScenarioRow.id)
        .limit(1)
    )


async def ensure_fuzz_scenario(
    session: AsyncSession,
    bundle: BundleRow,
    view: ScenarioBundleView,
    role: str,
    interface_id: str,
) -> StoredFuzzScenario:
    yaml_text = document_yaml(fuzz_document(role, interface_id))
    digest = hashlib.sha256(yaml_text.encode("utf-8")).hexdigest()
    check = validate_scenario_text(yaml_text, view)
    status = ScenarioStatus.accepted if check.validation.valid else ScenarioStatus.invalid
    existing = await find_current(session, bundle.target_id, fuzz_scenario_key(role, interface_id))
    if existing is not None and (existing.provenance or {}).get(HASH_KEY) == digest:
        existing.bundle_id = bundle.id
        existing.validation = check.validation.model_dump(mode="json")
        if existing.status in REFRESHABLE_STATUSES:
            existing.status = status
        await session.flush()
        return StoredFuzzScenario(existing, role, interface_id)
    if existing is not None:
        existing.status = ScenarioStatus.retired
    row = ScenarioRow(
        id=new_id(),
        target_id=bundle.target_id,
        bundle_id=bundle.id,
        feature_id=None,
        cell_id=None,
        title=f"API fuzz as {role}",
        family=FUZZ_FAMILY,
        origin=ScenarioOrigin.generated,
        status=status,
        version=1,
        yaml=yaml_text,
        parsed=check.parsed if check.parsed is not None else fuzz_document(role, interface_id),
        validation=check.validation.model_dump(mode="json"),
        provenance=provenance_of(bundle, role, interface_id, digest),
    )
    session.add(row)
    await session.flush()
    return StoredFuzzScenario(row, role, interface_id)


async def find_run_scenario(
    session: AsyncSession, run_id: uuid.UUID, stored: StoredFuzzScenario
) -> RunScenarioRow | None:
    return await session.scalar(
        select(RunScenarioRow).where(
            RunScenarioRow.run_id == run_id,
            RunScenarioRow.scenario_id == stored.row.id,
            RunScenarioRow.role == stored.role,
            RunScenarioRow.interface_id == stored.interface_id,
        )
    )


def queued_event(run_id: uuid.UUID, row: RunScenarioRow, stored: StoredFuzzScenario) -> IngestEvent:
    return build_event(
        run_id,
        SCENARIO_QUEUED_EVENT,
        ScenarioQueuedPayload(
            run_scenario_id=row.id,
            scenario_id=stored.row.id,
            title=stored.row.title,
            role=stored.role,
            interface_id=stored.interface_id,
            attempts_total=FUZZ_ATTEMPTS,
        ),
        f"{SCENARIO_QUEUED_EVENT}:{row.id}",
    )


def skipped_entry(verdict: Verdict) -> dict[str, Any]:
    return {
        "attempt": 0,
        "status": RunScenarioStatus.skipped.value,
        "verdict": verdict.model_dump(mode="json"),
    }


def new_run_scenario(
    run_id: uuid.UUID, stored: StoredFuzzScenario, skip: tuple[SkipReason, str] | None
) -> RunScenarioRow:
    verdict = None if skip is None else skipped_verdict(skip[0], skip[1])
    skipped = verdict is not None
    return RunScenarioRow(
        id=new_id(),
        run_id=run_id,
        scenario_id=stored.row.id,
        scenario_version=stored.row.version,
        role=stored.role,
        interface_id=stored.interface_id,
        attempts_total=FUZZ_ATTEMPTS,
        status=RunScenarioStatus.skipped if skipped else RunScenarioStatus.queued,
        verdict=None if verdict is None else verdict.model_dump(mode="json"),
        skip_reason=None if skip is None else skip[0],
        attempts=[
            skipped_entry(verdict)
            if verdict is not None
            else {"attempt": 0, "status": RunScenarioStatus.queued.value, "verdict": None}
        ],
        finished_at=datetime.now(UTC) if skipped else None,
    )


async def ensure_run_scenario(
    session: AsyncSession,
    run_id: uuid.UUID,
    stored: StoredFuzzScenario,
    skip: tuple[SkipReason, str] | None,
) -> RunScenarioSlot:
    existing = await find_run_scenario(session, run_id, stored)
    if existing is not None:
        return RunScenarioSlot(existing, False, [])
    row = new_run_scenario(run_id, stored, skip)
    session.add(row)
    await session.flush()
    events = [queued_event(run_id, row, stored)]
    if row.verdict is not None:
        events.append(finished_event(row, Verdict.model_validate(row.verdict), 0))
    return RunScenarioSlot(row, True, events)
