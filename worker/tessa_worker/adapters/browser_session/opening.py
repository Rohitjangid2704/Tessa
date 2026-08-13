import logging

from tessa_api.db.models import BundleRow, RunRow, RunScenarioRow, ScenarioRow
from tessa_api.db.session import SessionFactory
from tessa_api.ids import new_id
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind
from tessa_api.services.artifact_store import ArtifactStore
from tessa_api.services.smoke_generator import load_bundle_flows
from tessa_api.services.storage import BundleStore
from tessa_api.services.vault import Vault
from tessa_worker.activities.drive_ports import (
    AdapterOpener,
    AdapterOpenError,
    AdapterOpenRequest,
)
from tessa_worker.adapters.auth import ResolvedEnvironment, load_environment
from tessa_worker.adapters.browser import BrowserAdapter
from tessa_worker.adapters.browser_session.login import plan_login
from tessa_worker.adapters.browser_session.session import (
    EventSink,
    ExplorerSession,
    LoadedSession,
    SessionOpenError,
    SessionParts,
    SessionSpec,
)
from tessa_worker.adapters.browser_session.snapshot import SnapshotStore
from tessa_worker.adapters.browser_session.step_recorder import StepRecorder
from tessa_worker.adapters.context import resolve_interface
from tessa_worker.adapters.errors import InterfaceUnresolvedError
from tessa_worker.lab.explore.guard import origins_of
from tessa_worker.settings import WorkerSettings

logger = logging.getLogger("tessa_worker.browser_session")


def browser_origins(manifest: BundleManifest, environment: ResolvedEnvironment) -> frozenset[str]:
    addresses: list[str] = []
    for interface in manifest.interfaces:
        if interface.kind is not AdapterKind.browser:
            continue
        try:
            addresses.append(resolve_interface(manifest, interface.id, environment).base_url)
        except InterfaceUnresolvedError:
            continue
    return origins_of(addresses)


class ExplorerSessions:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        adapters: AdapterOpener,
        artifacts: ArtifactStore,
        bundles: BundleStore,
        vault: Vault,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.adapters = adapters
        self.artifacts = artifacts
        self.bundles = bundles
        self.vault = vault
        self.snapshots = SnapshotStore(artifacts)

    async def load(self, spec: SessionSpec) -> LoadedSession:
        async with self.session_factory() as session:
            run = await session.get(RunRow, spec.run_id)
            run_scenario = await session.get(RunScenarioRow, spec.run_scenario_id)
            scenario = (
                None
                if run_scenario is None
                else await session.get(ScenarioRow, run_scenario.scenario_id)
            )
            bundle = (
                None
                if run is None or run.bundle_id is None
                else await session.get(BundleRow, run.bundle_id)
            )
            if run is None or run_scenario is None or scenario is None or bundle is None:
                raise SessionOpenError("the run, its scenario or its bundle no longer exists")
            if run.target_id is None or bundle.manifest is None:
                raise SessionOpenError("the run has no target or the bundle has no manifest")
            manifest = BundleManifest.model_validate(bundle.manifest)
            environment = await load_environment(session, self.vault, run.target_id)
        flows = await load_bundle_flows(self.bundles, bundle)
        login = plan_login(flows, run_scenario.role)
        if login.missing_for(run_scenario.role):
            raise SessionOpenError(
                f"the bundle describes how to sign in for other roles but not for "
                f"{run_scenario.role}: add a flow of that role that fills the credential "
                "placeholders and submits"
            )
        return LoadedSession(
            target_id=run.target_id,
            bundle_id=bundle.id,
            role=run_scenario.role,
            interface_id=run_scenario.interface_id,
            read_only=run.read_only,
            scenario_title=scenario.title,
            allowed_origins=browser_origins(manifest, environment),
            login=login.steps,
        )

    async def open(self, spec: SessionSpec, sink: EventSink | None = None) -> ExplorerSession:
        loaded = await self.load(spec)
        browser_session_id = new_id()
        try:
            opened = await self.adapters.open(
                AdapterOpenRequest(
                    target_id=loaded.target_id,
                    bundle_id=loaded.bundle_id,
                    role=loaded.role,
                    interface_id=loaded.interface_id,
                    run_id=spec.run_id,
                    run_scenario_id=spec.run_scenario_id,
                    attempt=spec.attempt,
                    read_only=loaded.read_only,
                    step_timeout_seconds=float(self.settings.scenario_timeout_seconds),
                    browser_session_id=browser_session_id,
                )
            )
        except AdapterOpenError as error:
            raise SessionOpenError(str(error)) from None
        adapter = opened.adapter
        if not isinstance(adapter, BrowserAdapter):
            await adapter.close()
            raise SessionOpenError(
                f"interface {loaded.interface_id} is not served by the browser adapter"
            )
        session = ExplorerSession(
            SessionParts(
                spec=spec,
                loaded=loaded,
                browser_session_id=browser_session_id,
                opened=opened,
                adapter=adapter,
                recorder=StepRecorder(
                    self.session_factory,
                    self.artifacts,
                    spec.run_id,
                    spec.run_scenario_id,
                    spec.attempt,
                    browser_session_id,
                ),
                snapshots=self.snapshots,
                session_factory=self.session_factory,
            ),
            sink,
        )
        try:
            await session.start()
        except BaseException as error:
            await session.close()
            if isinstance(error, SessionOpenError):
                error.events.extend(session.drain_events())
            raise
        return session
