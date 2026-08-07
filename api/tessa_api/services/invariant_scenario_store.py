import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, ScenarioRow
from tessa_api.ids import new_id
from tessa_api.schemas.enums import ScenarioOrigin, ScenarioStatus
from tessa_api.services.invariant_scenarios import INVARIANT_FAMILY, PlannedInvariantScenario
from tessa_api.services.scenario_validator import (
    ScenarioBundleView,
    ScenarioCheck,
    validate_scenario_text,
)
from tessa_api.services.smoke_generator import document_yaml

INVARIANT_GENERATOR = "invariant"
HASH_KEY = "document_hash"
INVARIANT_ID_KEY = "invariant_id"
REFRESHABLE_STATUSES = (ScenarioStatus.accepted, ScenarioStatus.invalid)


@dataclass(frozen=True, slots=True)
class StoredInvariantScenario:
    planned: PlannedInvariantScenario
    row: ScenarioRow
    created: bool

    @property
    def runnable(self) -> bool:
        return self.row.status is ScenarioStatus.accepted


def status_for(check: ScenarioCheck) -> ScenarioStatus:
    return ScenarioStatus.accepted if check.validation.valid else ScenarioStatus.invalid


def provenance_of(bundle: BundleRow, planned: PlannedInvariantScenario) -> dict[str, Any]:
    return {
        "generator": INVARIANT_GENERATOR,
        INVARIANT_ID_KEY: planned.invariant_id.value,
        "role": planned.role,
        "interface_id": planned.interface_id,
        HASH_KEY: planned.document_hash,
        "bundle_version": bundle.version,
    }


def new_row(
    bundle: BundleRow, planned: PlannedInvariantScenario, check: ScenarioCheck, yaml_text: str
) -> ScenarioRow:
    return ScenarioRow(
        id=new_id(),
        target_id=bundle.target_id,
        bundle_id=bundle.id,
        feature_id=None,
        cell_id=None,
        title=str(planned.document["title"]),
        family=INVARIANT_FAMILY,
        origin=ScenarioOrigin.generated,
        status=status_for(check),
        version=1,
        yaml=yaml_text,
        parsed=check.parsed if check.parsed is not None else dict(planned.document),
        validation=check.validation.model_dump(mode="json"),
        provenance=provenance_of(bundle, planned),
    )


async def lock_invariant_scenarios(session: AsyncSession, target_id: uuid.UUID) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"invariants:{target_id}"},
    )


async def find_current(session: AsyncSession, target_id: uuid.UUID, key: str) -> ScenarioRow | None:
    return await session.scalar(
        select(ScenarioRow)
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.family == INVARIANT_FAMILY,
            ScenarioRow.status != ScenarioStatus.retired,
            ScenarioRow.parsed["id"].astext == key,
        )
        .order_by(ScenarioRow.created_at.desc(), ScenarioRow.id)
        .limit(1)
    )


def refresh(row: ScenarioRow, bundle: BundleRow, check: ScenarioCheck) -> None:
    row.bundle_id = bundle.id
    row.validation = check.validation.model_dump(mode="json")
    if row.status in REFRESHABLE_STATUSES:
        row.status = status_for(check)


async def upsert_invariant_scenario(
    session: AsyncSession,
    bundle: BundleRow,
    view: ScenarioBundleView,
    planned: PlannedInvariantScenario,
) -> StoredInvariantScenario:
    yaml_text = document_yaml(planned.document)
    check = validate_scenario_text(yaml_text, view)
    existing = await find_current(session, bundle.target_id, planned.key)
    if existing is not None and (existing.provenance or {}).get(HASH_KEY) == planned.document_hash:
        refresh(existing, bundle, check)
        await session.flush()
        return StoredInvariantScenario(planned, existing, False)
    if existing is not None:
        existing.status = ScenarioStatus.retired
    row = new_row(bundle, planned, check, yaml_text)
    session.add(row)
    await session.flush()
    return StoredInvariantScenario(planned, row, True)
