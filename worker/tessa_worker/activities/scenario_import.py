from temporalio import activity
from temporalio.exceptions import ApplicationError

from tessa_api.db.models import BundleRow
from tessa_api.db.models import Target as TargetRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.enums import BundleValidationStatus
from tessa_api.schemas.temporal import (
    IMPORT_AUTHORED_SCENARIOS_ACTIVITY,
    ImportAuthoredScenariosInput,
    ImportAuthoredScenariosResult,
)
from tessa_api.services.scenario_import import (
    import_authored_scenarios as import_scenarios,
)
from tessa_api.services.scenario_import import (
    read_stored_scenario_files,
    settle_without_dry_runs,
    stored_cell_resolver,
)
from tessa_api.services.storage import BundleStore
from tessa_worker.event_client import EventClient

NOT_IMPORTABLE = "bundle_not_importable"
NO_DRY_RUN_MESSAGE = (
    "The scenario was imported from a stored bundle without dry runs, so it waits for a review"
)


class ScenarioImportActivities:
    def __init__(
        self, session_factory: SessionFactory, bundles: BundleStore, events: EventClient
    ) -> None:
        self.session_factory = session_factory
        self.bundles = bundles
        self.events = events

    @activity.defn(name=IMPORT_AUTHORED_SCENARIOS_ACTIVITY)
    async def import_authored_scenarios(
        self, request: ImportAuthoredScenariosInput
    ) -> ImportAuthoredScenariosResult:
        async with self.session_factory() as session:
            bundle = await session.get(BundleRow, request.bundle_id)
            if bundle is None or bundle.validation_status is not BundleValidationStatus.valid:
                raise ApplicationError(
                    f"bundle {request.bundle_id} is missing or not valid",
                    type=NOT_IMPORTABLE,
                    non_retryable=True,
                )
            target = await session.get(TargetRow, bundle.target_id)
            if target is None:
                raise ApplicationError(
                    f"target of bundle {request.bundle_id} is missing",
                    type=NOT_IMPORTABLE,
                    non_retryable=True,
                )
            files = await read_stored_scenario_files(self.bundles, bundle)
            imported = await import_scenarios(
                session,
                target,
                bundle,
                files,
                bundle.uploaded_by,
                stored_cell_resolver(target, bundle),
            )
            settled = await settle_without_dry_runs(
                session, imported.awaiting_dry_run, NO_DRY_RUN_MESSAGE
            )
            await session.commit()
        events = [*imported.events, *settled]
        if events:
            await self.events.deliver(events)
        return ImportAuthoredScenariosResult(
            imported=len(imported.imported),
            rejected=imported.rejected,
            scenario_ids=imported.scenario_ids,
        )
