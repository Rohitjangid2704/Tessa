import logging
import uuid
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.temporal import PLAN_COVERAGE_WORKFLOW, PlanCoverageInput
from tessa_api.services.coverage import default_budget, ensure_baseline_plan, new_generate_run
from tessa_api.services.coverage_events import publish_coverage_events
from tessa_api.services.run_guard import assess_production
from tessa_api.services.run_service import record_start_failure, run_created_event
from tessa_api.services.scenario_import import ScenarioImport, settle_without_dry_runs
from tessa_api.services.targets import get_target
from tessa_api.services.vault import Vault
from tessa_api.settings import Settings
from tessa_api.streams.hub import Hub
from tessa_api.streams.ingest import append_events
from tessa_api.temporal_client import TemporalGateway

logger = logging.getLogger("tessa_api.scenario_import")

PRODUCTION_MESSAGE = (
    "The target is a production target: dry runs never run there, so the scenario waits for "
    "a review without them"
)
START_FAILED_MESSAGE = (
    "The dry-run workflow could not be started, so the scenario waits for a review without dry runs"
)


async def skip_and_publish(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    scenario_ids: Sequence[uuid.UUID],
    message: str,
) -> None:
    events = await settle_without_dry_runs(session, scenario_ids, message)
    await session.commit()
    await publish_coverage_events(session_factory, hub, events)


async def start_authored_dry_runs(
    session: AsyncSession,
    session_factory: SessionFactory,
    hub: Hub,
    temporal: TemporalGateway,
    settings: Settings,
    vault: Vault,
    user_id: uuid.UUID,
    bundle: BundleRow,
    imported: ScenarioImport,
) -> uuid.UUID | None:
    await publish_coverage_events(session_factory, hub, imported.events)
    pending = imported.awaiting_dry_run
    if not pending:
        return None
    target = await get_target(session, bundle.target_id)
    assessment = await assess_production(session, settings, vault, target)
    if assessment.production:
        await skip_and_publish(session, session_factory, hub, pending, PRODUCTION_MESSAGE)
        return None
    plan = await ensure_baseline_plan(session, settings, target, bundle, user_id)
    budget = await default_budget(session, settings)
    run = new_generate_run(new_id(), plan, bundle, budget, user_id)
    session.add(run)
    await session.commit()
    try:
        await append_events(session_factory, hub, [run_created_event(run)])
        await temporal.start_workflow(
            PLAN_COVERAGE_WORKFLOW,
            PlanCoverageInput(
                plan_id=plan.id, run_id=run.id, mode="dry_run", scenario_ids=list(pending)
            ),
            run.workflow_id,
        )
    except Exception:
        logger.exception(
            "authored_dry_run_not_started",
            extra={"run_id": str(run.id), "bundle_id": str(bundle.id)},
        )
        await record_start_failure(session_factory, hub, run)
        await skip_and_publish(session, session_factory, hub, pending, START_FAILED_MESSAGE)
        return None
    return run.id
