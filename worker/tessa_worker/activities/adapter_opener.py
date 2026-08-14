from tessa_api.db.models import BundleRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind, SkipReason
from tessa_api.services.vault import Vault
from tessa_worker.activities.drive_ports import (
    AdapterOpenError,
    AdapterOpenRequest,
    OpenedAdapter,
)
from tessa_worker.adapters.auth import load_environment
from tessa_worker.adapters.base import Adapter
from tessa_worker.adapters.browser import BrowserRuntime
from tessa_worker.adapters.context import (
    AdapterContext,
    AdapterLimits,
    RunScope,
    build_adapter_context,
)
from tessa_worker.adapters.errors import AdapterRefusedError, UnsupportedAdapterError
from tessa_worker.adapters.registry import AdapterRegistry
from tessa_worker.checks.internal_ids import build_tier0_context
from tessa_worker.mutation.override import (
    OverrideNotApplicableError,
    override_environment,
    read_base_url_override,
)
from tessa_worker.settings import WorkerSettings


class RegistryAdapterOpener:
    def __init__(
        self,
        session_factory: SessionFactory,
        vault: Vault,
        registry: AdapterRegistry,
        settings: WorkerSettings,
        browser: BrowserRuntime | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.vault = vault
        self.registry = registry
        self.settings = settings
        self.browser = browser

    async def open(self, request: AdapterOpenRequest) -> OpenedAdapter:
        async with self.session_factory() as session:
            bundle = await session.get(BundleRow, request.bundle_id)
            if bundle is None or bundle.manifest is None:
                raise AdapterOpenError("the bundle of the run has no readable manifest")
            manifest = BundleManifest.model_validate(bundle.manifest)
            environment = await load_environment(session, self.vault, request.target_id)
            override = await read_base_url_override(session, request.run_id)
        try:
            environment = override_environment(manifest, environment, override)
        except OverrideNotApplicableError as error:
            raise AdapterOpenError(str(error)) from None
        redactor = environment.new_redactor()
        try:
            context = build_adapter_context(
                manifest,
                environment,
                request.role,
                request.interface_id,
                AdapterLimits.from_settings(self.settings, request.step_timeout_seconds),
                scope=RunScope.for_run(request.read_only),
                needs_network=self.needs_network(manifest, request.interface_id),
            )
            adapter = await self.open_adapter(request, context)
        except AdapterRefusedError as error:
            raise AdapterOpenError(
                redactor.redact_text(str(error)), SkipReason.adapter_unsupported
            ) from None
        except UnsupportedAdapterError as error:
            raise AdapterOpenError(
                f"{type(error).__name__}: {redactor.redact_text(str(error))}",
                SkipReason.adapter_unsupported,
            ) from None
        except Exception as error:
            raise AdapterOpenError(
                f"{type(error).__name__}: {redactor.redact_text(str(error))}"
            ) from None
        return OpenedAdapter(
            adapter=adapter,
            redact=context.redactor.redact_text,
            tier0_context=build_tier0_context(manifest),
        )

    def needs_network(self, manifest: BundleManifest, interface_id: str) -> bool:
        declared = next((item for item in manifest.interfaces if item.id == interface_id), None)
        return self.registry.needs_network(None if declared is None else declared.kind)

    async def open_adapter(self, request: AdapterOpenRequest, context: AdapterContext) -> Adapter:
        if context.interface.kind is AdapterKind.browser and self.browser is not None:
            return await self.browser.open_adapter(context, request.browser_session_id)
        return await self.registry.open(context)
