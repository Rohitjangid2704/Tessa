import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow, InvariantResultRow, PlanRow, RunRow, RunScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import (
    AdapterKind,
    RunKind,
    RunScenarioStatus,
    SkipReason,
    VerdictStatus,
    VerdictTier,
)
from tessa_api.schemas.invariants import INVARIANT_PACK_BY_ID
from tessa_api.schemas.plans import PlanSelection
from tessa_api.schemas.streams import IngestEvent, ScenarioQueuedPayload
from tessa_api.schemas.temporal import (
    ENSURE_INVARIANT_SCENARIOS_ACTIVITY,
    EnsureInvariantScenariosInput,
    EnsureInvariantScenariosResult,
    InvariantScenarioSkip,
)
from tessa_api.services.invariant_scenario_store import (
    StoredInvariantScenario,
    lock_invariant_scenarios,
    upsert_invariant_scenario,
)
from tessa_api.services.invariant_scenarios import (
    InvariantPlan,
    PlannedSkip,
    plan_invariant_scenarios,
    restrict_to_selection,
)
from tessa_api.services.invariants.attacks import AttackPack, AttackPackError, load_attack_pack
from tessa_api.services.plans import build_context
from tessa_api.services.scenario_library import scenario_view_for_bundle
from tessa_worker.activities.config_snapshot import lock_unfrozen_run, merge_into_config
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.invariants.results import new_result_row, result_event
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.invariants")

ATTACK_PACK_INVALID = "attack_pack_invalid"
MANIFEST_INVALID = "bundle_manifest_invalid"
INVARIANT_SCENARIO_RUN_KINDS = frozenset({RunKind.suite, RunKind.mutation})
RUN_SCENARIO_ATTEMPTS = 1
INVALID_SCENARIO_MESSAGE = "the generated scenario does not validate"
SCENARIO_QUEUED_EVENT = "scenario.queued"


@dataclass(frozen=True, slots=True)
class EnsureOutcome:
    scenario_ids: list[uuid.UUID]
    created: int
    reused: int
    skipped: list[InvariantScenarioSkip]
    events: list[IngestEvent]


EMPTY_OUTCOME = EnsureOutcome([], 0, 0, [], [])


def permanent(message: str, error_type: str) -> ApplicationError:
    return ApplicationError(message, type=error_type, non_retryable=True)


def parse_manifest(bundle: BundleRow) -> BundleManifest:
    try:
        return BundleManifest.model_validate(bundle.manifest)
    except ValidationError:
        raise permanent(f"bundle {bundle.id} has no valid manifest", MANIFEST_INVALID) from None


def load_attacks(settings: WorkerSettings) -> AttackPack:
    try:
        return load_attack_pack(settings.probes_dir)
    except AttackPackError as error:
        raise permanent(f"the attack pack is invalid: {error}", ATTACK_PACK_INVALID) from None


def first_error(stored: StoredInvariantScenario) -> str:
    errors = stored.row.validation.get("errors") or []
    first = errors[0].get("message") if errors and isinstance(errors[0], dict) else None
    return f"{INVALID_SCENARIO_MESSAGE}: {first}" if first else INVALID_SCENARIO_MESSAGE


def invalid_skip(stored: StoredInvariantScenario) -> PlannedSkip:
    planned = stored.planned
    return PlannedSkip(
        planned.invariant_id,
        planned.role,
        planned.interface_id,
        SkipReason.precondition_failed,
        first_error(stored),
    )


def run_scenario_values(run_id: uuid.UUID, stored: StoredInvariantScenario) -> dict[str, Any]:
    return {
        "id": new_id(),
        "run_id": run_id,
        "scenario_id": stored.row.id,
        "scenario_version": stored.row.version,
        "role": stored.planned.role,
        "interface_id": stored.planned.interface_id,
        "attempts_total": RUN_SCENARIO_ATTEMPTS,
        "status": RunScenarioStatus.queued,
        "verdict": None,
        "skip_reason": None,
        "attempts": [
            {"attempt": attempt, "status": RunScenarioStatus.queued.value, "verdict": None}
            for attempt in range(RUN_SCENARIO_ATTEMPTS)
        ],
        "finished_at": None,
    }


def queued_event(
    run_id: uuid.UUID, row_id: uuid.UUID, stored: StoredInvariantScenario
) -> IngestEvent:
    return build_event(
        run_id,
        SCENARIO_QUEUED_EVENT,
        ScenarioQueuedPayload(
            run_scenario_id=row_id,
            scenario_id=stored.row.id,
            title=stored.row.title,
            role=stored.planned.role,
            interface_id=stored.planned.interface_id,
            attempts_total=RUN_SCENARIO_ATTEMPTS,
        ),
        f"{SCENARIO_QUEUED_EVENT}:{row_id}",
    )


def skip_rows(run_id: uuid.UUID, skips: Sequence[PlannedSkip]) -> list[InvariantResultRow]:
    return [
        new_result_row(
            run_id=run_id,
            run_scenario_id=None,
            step_id=None,
            attempt=None,
            invariant_id=skip.invariant_id.value,
            pack=INVARIANT_PACK_BY_ID[skip.invariant_id],
            status=VerdictStatus.skipped,
            tier=VerdictTier.code,
            confidence=None,
            message=skip.detail,
            skip_reason=skip.reason,
            ordinal=ordinal,
        )
        for ordinal, skip in enumerate(skips)
    ]


def interface_kinds_of(manifest: BundleManifest) -> dict[str, AdapterKind]:
    return {interface.id: interface.kind for interface in manifest.interfaces}


class InvariantScenarioActivities:
    def __init__(
        self, settings: WorkerSettings, session_factory: SessionFactory, events: EventClient
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events

    @activity.defn(name=ENSURE_INVARIANT_SCENARIOS_ACTIVITY)
    async def ensure_invariant_scenarios(
        self, request: EnsureInvariantScenariosInput
    ) -> EnsureInvariantScenariosResult:
        async with self.session_factory() as session:
            outcome = await self.ensure(session, request.run_id)
            await session.commit()
        await self.events.deliver_all(outcome.events)
        return EnsureInvariantScenariosResult(
            scenario_ids=outcome.scenario_ids,
            created=outcome.created,
            reused=outcome.reused,
            skipped=outcome.skipped,
        )

    async def ensure(self, session: AsyncSession, run_id: uuid.UUID) -> EnsureOutcome:
        run = await lock_unfrozen_run(session, run_id)
        if (
            run.kind not in INVARIANT_SCENARIO_RUN_KINDS
            or run.plan_id is None
            or run.bundle_id is None
        ):
            return EMPTY_OUTCOME
        plan_row = await session.get(PlanRow, run.plan_id)
        bundle = await session.get(BundleRow, run.bundle_id)
        if plan_row is None or bundle is None or bundle.manifest is None:
            raise permanent(f"run {run_id} lost its plan or bundle", MANIFEST_INVALID)
        manifest = parse_manifest(bundle)
        planned = restrict_to_selection(
            plan_invariant_scenarios(
                manifest,
                await build_context(session, bundle, run.read_only),
                load_attacks(self.settings),
            ),
            PlanSelection.model_validate(plan_row.selection),
            interface_kinds_of(manifest),
        )
        return await self.store(session, run, bundle, planned)

    async def store(
        self, session: AsyncSession, run: RunRow, bundle: BundleRow, planned: InvariantPlan
    ) -> EnsureOutcome:
        await lock_invariant_scenarios(session, bundle.target_id)
        view = await scenario_view_for_bundle(session, bundle.target_id, bundle.id)
        stored = [
            await upsert_invariant_scenario(session, bundle, view, item)
            for item in planned.scenarios
        ]
        runnable = [item for item in stored if item.runnable]
        skips = [*planned.skips, *(invalid_skip(item) for item in stored if not item.runnable)]
        queued = await self.insert_run_scenarios(session, run.id, runnable)
        merge_into_config(
            run,
            {
                "scenario_versions": {
                    **run.config_snapshot.get("scenario_versions", {}),
                    **{str(item.row.id): item.row.version for item in runnable},
                }
            },
        )
        rows = await self.replace_skip_results(session, run.id, skips)
        logger.info(
            "invariant_scenarios_ensured",
            extra={
                "run_id": str(run.id),
                "scenarios": len(runnable),
                "scenarios_created": sum(item.created for item in runnable),
                "skips": len(skips),
            },
        )
        return EnsureOutcome(
            scenario_ids=[item.row.id for item in runnable],
            created=sum(item.created for item in runnable),
            reused=sum(not item.created for item in runnable),
            skipped=[skip.to_result() for skip in skips],
            events=[*queued, *(result_event(row) for row in rows)],
        )

    async def insert_run_scenarios(
        self, session: AsyncSession, run_id: uuid.UUID, runnable: Sequence[StoredInvariantScenario]
    ) -> list[IngestEvent]:
        if not runnable:
            return []
        by_identity = {
            (item.row.id, item.planned.role, item.planned.interface_id): item for item in runnable
        }
        result = await session.execute(
            insert(RunScenarioRow)
            .values([run_scenario_values(run_id, item) for item in runnable])
            .on_conflict_do_nothing(
                index_elements=[
                    RunScenarioRow.run_id,
                    RunScenarioRow.scenario_id,
                    RunScenarioRow.role,
                    RunScenarioRow.interface_id,
                ]
            )
            .returning(
                RunScenarioRow.id,
                RunScenarioRow.scenario_id,
                RunScenarioRow.role,
                RunScenarioRow.interface_id,
            )
        )
        inserted = sorted(
            (row_id, by_identity[(scenario_id, role, interface_id)])
            for row_id, scenario_id, role, interface_id in result
        )
        return [queued_event(run_id, row_id, item) for row_id, item in inserted]

    async def replace_skip_results(
        self, session: AsyncSession, run_id: uuid.UUID, skips: Sequence[PlannedSkip]
    ) -> list[InvariantResultRow]:
        await session.execute(
            delete(InvariantResultRow).where(
                InvariantResultRow.run_id == run_id,
                InvariantResultRow.run_scenario_id.is_(None),
                InvariantResultRow.attempt.is_(None),
                InvariantResultRow.status == VerdictStatus.skipped,
            )
        )
        rows = skip_rows(run_id, skips)
        session.add_all(rows)
        await session.flush()
        return rows
