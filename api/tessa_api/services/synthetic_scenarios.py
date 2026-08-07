import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow
from tessa_api.ids import new_id
from tessa_api.schemas.enums import (
    RunScenarioStatus,
    ScenarioOrigin,
    ScenarioStatus,
    SyntheticFamily,
)
from tessa_api.schemas.scenario import SCENARIO_SCHEMA_VERSION
from tessa_api.schemas.streams import ScenarioQueuedPayload
from tessa_api.services.scenario_library import scenario_view_for_bundle
from tessa_api.services.scenario_validator import ScenarioCheck, validate_scenario_text
from tessa_api.services.smoke_generator import document_hash, document_yaml

AGENT_SYNTHETIC_FAMILIES = (
    SyntheticFamily.exploration,
    SyntheticFamily.simulation,
    SyntheticFamily.redteam,
)
TITLE_MAX_CHARS = 200
HASH_KEY = "document_hash"
KEY_PROVENANCE = "synthetic_key"
FIRST_VERSION = 1


class SyntheticScenarioError(Exception):
    pass


class SyntheticRunMissingError(SyntheticScenarioError):
    pass


class SyntheticFamilyNotAllowedError(SyntheticScenarioError):
    pass


class SyntheticScenarioInvalidError(SyntheticScenarioError):
    def __init__(self, message: str, code: str | None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SyntheticScenarioRequest:
    run_id: uuid.UUID
    family: SyntheticFamily
    key: str
    title: str
    role: str
    interface_id: str
    attempts: int
    document: dict[str, Any]


@dataclass(frozen=True, slots=True)
class SyntheticScenario:
    scenario_id: uuid.UUID
    scenario_version: int
    run_scenario_id: uuid.UUID
    created: bool


class SyntheticScenarioStore(Protocol):
    async def create(
        self, session: AsyncSession, request: SyntheticScenarioRequest
    ) -> SyntheticScenario: ...

    async def find(
        self, session: AsyncSession, run_id: uuid.UUID, key: str
    ) -> SyntheticScenario | None: ...


def full_document(request: SyntheticScenarioRequest) -> dict[str, Any]:
    header: dict[str, Any] = {
        "schema_version": SCENARIO_SCHEMA_VERSION,
        "id": request.key,
        "title": request.title[:TITLE_MAX_CHARS],
        "family": request.family.value,
        "role": request.role,
        "interface_id": request.interface_id,
        "synthetic": True,
    }
    body = {name: value for name, value in request.document.items() if name not in header}
    return {**header, **body}


def first_problem(check: ScenarioCheck) -> tuple[str, str | None]:
    errors = check.validation.errors
    if not errors:
        return "the synthetic scenario does not validate", None
    return errors[0].message, errors[0].code


def provenance_of(
    bundle: BundleRow, request: SyntheticScenarioRequest, digest: str
) -> dict[str, Any]:
    return {
        "generator": request.family.value,
        "role": request.role,
        "interface_id": request.interface_id,
        KEY_PROVENANCE: request.key,
        HASH_KEY: digest,
        "bundle_version": bundle.version,
    }


async def lock_family(session: AsyncSession, target_id: uuid.UUID, family: SyntheticFamily) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"synthetic:{family.value}:{target_id}"},
    )


async def find_current_scenario(
    session: AsyncSession, target_id: uuid.UUID, family: SyntheticFamily, key: str
) -> ScenarioRow | None:
    return await session.scalar(
        select(ScenarioRow)
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.family == family.value,
            ScenarioRow.status != ScenarioStatus.retired,
            ScenarioRow.parsed["id"].astext == key,
        )
        .order_by(ScenarioRow.created_at.desc(), ScenarioRow.id)
        .limit(1)
    )


async def store_scenario(
    session: AsyncSession,
    bundle: BundleRow,
    request: SyntheticScenarioRequest,
    document: dict[str, Any],
    check: ScenarioCheck,
) -> ScenarioRow:
    digest = document_hash(document)
    existing = await find_current_scenario(session, bundle.target_id, request.family, request.key)
    if existing is not None and (existing.provenance or {}).get(HASH_KEY) == digest:
        existing.bundle_id = bundle.id
        existing.validation = check.validation.model_dump(mode="json")
        existing.status = ScenarioStatus.accepted
        await session.flush()
        return existing
    if existing is not None:
        existing.status = ScenarioStatus.retired
    row = ScenarioRow(
        id=new_id(),
        target_id=bundle.target_id,
        bundle_id=bundle.id,
        feature_id=None,
        cell_id=None,
        title=str(document["title"]),
        family=request.family.value,
        origin=ScenarioOrigin.generated,
        status=ScenarioStatus.accepted,
        version=FIRST_VERSION,
        yaml=document_yaml(document),
        parsed=check.parsed if check.parsed is not None else dict(document),
        validation=check.validation.model_dump(mode="json"),
        provenance=provenance_of(bundle, request, digest),
    )
    session.add(row)
    await session.flush()
    return row


def run_scenario_values(
    run_id: uuid.UUID, scenario: ScenarioRow, request: SyntheticScenarioRequest
) -> dict[str, Any]:
    return {
        "id": new_id(),
        "run_id": run_id,
        "scenario_id": scenario.id,
        "scenario_version": scenario.version,
        "role": request.role,
        "interface_id": request.interface_id,
        "attempts_total": request.attempts,
        "status": RunScenarioStatus.queued,
        "verdict": None,
        "skip_reason": None,
        "attempts": [
            {"attempt": attempt, "status": RunScenarioStatus.queued.value, "verdict": None}
            for attempt in range(request.attempts)
        ],
        "finished_at": None,
    }


async def insert_run_scenario(
    session: AsyncSession,
    run_id: uuid.UUID,
    scenario: ScenarioRow,
    request: SyntheticScenarioRequest,
) -> tuple[uuid.UUID, bool]:
    inserted = await session.scalar(
        insert(RunScenarioRow)
        .values(**run_scenario_values(run_id, scenario, request))
        .on_conflict_do_nothing(
            index_elements=[
                RunScenarioRow.run_id,
                RunScenarioRow.scenario_id,
                RunScenarioRow.role,
                RunScenarioRow.interface_id,
            ]
        )
        .returning(RunScenarioRow.id)
    )
    if inserted is not None:
        return inserted, True
    existing = await session.scalar(
        select(RunScenarioRow.id).where(
            RunScenarioRow.run_id == run_id,
            RunScenarioRow.scenario_id == scenario.id,
            RunScenarioRow.role == request.role,
            RunScenarioRow.interface_id == request.interface_id,
        )
    )
    if existing is None:
        raise SyntheticScenarioError("the run scenario neither exists nor could be inserted")
    return existing, False


async def create_synthetic_run_scenario(
    session: AsyncSession, request: SyntheticScenarioRequest
) -> SyntheticScenario:
    if request.family not in AGENT_SYNTHETIC_FAMILIES:
        raise SyntheticFamilyNotAllowedError(
            f"{request.family.value} is not an agent family; use one of "
            f"{', '.join(family.value for family in AGENT_SYNTHETIC_FAMILIES)}"
        )
    run = await session.get(RunRow, request.run_id)
    if run is None or run.target_id is None or run.bundle_id is None:
        raise SyntheticRunMissingError(f"run {request.run_id} has no target or no bundle")
    bundle = await session.get(BundleRow, run.bundle_id)
    if bundle is None:
        raise SyntheticRunMissingError(f"bundle {run.bundle_id} of the run does not exist")
    document = full_document(request)
    view = await scenario_view_for_bundle(session, run.target_id, bundle.id)
    check = validate_scenario_text(document_yaml(document), view)
    if not check.validation.valid:
        message, code = first_problem(check)
        raise SyntheticScenarioInvalidError(message, code)
    await lock_family(session, run.target_id, request.family)
    scenario = await store_scenario(session, bundle, request, document, check)
    run_scenario_id, created = await insert_run_scenario(session, run.id, scenario, request)
    return SyntheticScenario(
        scenario_id=scenario.id,
        scenario_version=scenario.version,
        run_scenario_id=run_scenario_id,
        created=created,
    )


async def find_synthetic_run_scenario(
    session: AsyncSession, run_id: uuid.UUID, key: str
) -> SyntheticScenario | None:
    row = (
        await session.execute(
            select(RunScenarioRow.id, RunScenarioRow.scenario_id, RunScenarioRow.scenario_version)
            .join(ScenarioRow, ScenarioRow.id == RunScenarioRow.scenario_id)
            .where(
                RunScenarioRow.run_id == run_id,
                ScenarioRow.parsed["id"].astext == key,
                ScenarioRow.family.in_([family.value for family in AGENT_SYNTHETIC_FAMILIES]),
            )
            .order_by(RunScenarioRow.created_at, RunScenarioRow.id)
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    run_scenario_id, scenario_id, scenario_version = row
    return SyntheticScenario(
        scenario_id=scenario_id,
        scenario_version=scenario_version,
        run_scenario_id=run_scenario_id,
        created=False,
    )


def queued_payload(
    request: SyntheticScenarioRequest, scenario: SyntheticScenario
) -> ScenarioQueuedPayload:
    return ScenarioQueuedPayload(
        run_scenario_id=scenario.run_scenario_id,
        scenario_id=scenario.scenario_id,
        title=request.title[:TITLE_MAX_CHARS],
        role=request.role,
        interface_id=request.interface_id,
        attempts_total=request.attempts,
    )


class DatabaseSyntheticScenarios:
    async def create(
        self, session: AsyncSession, request: SyntheticScenarioRequest
    ) -> SyntheticScenario:
        return await create_synthetic_run_scenario(session, request)

    async def find(
        self, session: AsyncSession, run_id: uuid.UUID, key: str
    ) -> SyntheticScenario | None:
        return await find_synthetic_run_scenario(session, run_id, key)
