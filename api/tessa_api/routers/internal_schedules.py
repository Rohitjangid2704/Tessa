from fastapi import APIRouter

from tessa_api.deps import SessionDep, SessionFactoryDep, SettingsDep, service_key_dependency
from tessa_api.schemas.schedules import ScheduledRunStart, ScheduledRunStarted
from tessa_api.services import scheduled_runs
from tessa_api.services.vault import VaultDep
from tessa_api.streams.dependencies import HubDep

router = APIRouter(
    prefix="/internal/v1",
    tags=["internal"],
    include_in_schema=False,
    dependencies=[service_key_dependency],
)


@router.post("/scheduled-runs", response_model=ScheduledRunStarted)
async def start_scheduled_run(
    body: ScheduledRunStart,
    session: SessionDep,
    session_factory: SessionFactoryDep,
    settings: SettingsDep,
    vault: VaultDep,
    hub: HubDep,
) -> ScheduledRunStarted:
    return await scheduled_runs.start_scheduled_firing(
        session, session_factory, hub, settings, vault, body.schedule_id, body.run_id
    )
