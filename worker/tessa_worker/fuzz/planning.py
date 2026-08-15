from tessa_api.schemas.bundle import BundleManifest, Interface
from tessa_api.schemas.bundle_references import ALL_ROLES
from tessa_api.schemas.enums import AdapterKind
from tessa_api.schemas.plans import PlanSelection


def fuzz_roles(manifest: BundleManifest, selection: PlanSelection) -> list[str]:
    declared = [role.id for role in manifest.roles]
    if not selection.roles or ALL_ROLES in selection.roles:
        return declared
    wanted = set(selection.roles)
    return [role for role in declared if role in wanted]


def first_http_interface(manifest: BundleManifest) -> Interface | None:
    return next(
        (interface for interface in manifest.interfaces if interface.kind is AdapterKind.http),
        None,
    )
