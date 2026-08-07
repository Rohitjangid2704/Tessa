import copy
import uuid
from collections.abc import Mapping
from typing import Any

from tessa_api.schemas.bundle import BundleManifest, Interface
from tessa_api.schemas.bundle_references import ALL_ROLES
from tessa_api.schemas.enums import AdapterKind, SyntheticFamily
from tessa_api.schemas.scenario import SCENARIO_SCHEMA_VERSION
from tessa_api.services.smoke_generator import (
    DEFAULT_ASK_METHOD,
    ROOT_PATH,
    chat_body,
    chat_shape,
    inject_ask,
    request_document,
    truncated,
)

SIMULATION_FAMILY = SyntheticFamily.simulation
KEY_PREFIX = "sim"
KEY_ID_LENGTH = 12
TITLE_MAX_LENGTH = 200
PLACEHOLDER_ASK = "Hello"
PLACEHOLDER_LABEL = "Simulated user conversation"
PROBE_TEXT = "x"


def simulation_key(persona_id: uuid.UUID, goal_id: uuid.UUID, role: str) -> str:
    return f"{KEY_PREFIX}-{persona_id.hex[:KEY_ID_LENGTH]}-{goal_id.hex[:KEY_ID_LENGTH]}-{role}"


def simulation_title(persona_name: str, goal_title: str, role: str) -> str:
    return truncated(f"Simulation: {persona_name} wants {goal_title} as {role}", TITLE_MAX_LENGTH)


def accepts_ask(shape: Mapping[str, Any]) -> bool:
    template = shape.get("request_example")
    if template is None:
        return False
    return bool(inject_ask(copy.deepcopy(template), PROBE_TEXT)[1])


def is_chat_interface(interface: Interface) -> bool:
    if interface.kind is AdapterKind.sse:
        return True
    if interface.kind is not AdapterKind.http:
        return False
    described = interface.model_dump(mode="json")
    return any(accepts_ask(shape) for shape in described.get("shapes", []))


def serves_role(manifest: BundleManifest, interface_id: str, role_id: str) -> bool:
    return any(
        interface_id in feature.interfaces
        and (ALL_ROLES in feature.roles or role_id in feature.roles)
        for feature in manifest.features
    )


def select_chat_interface(manifest: BundleManifest, role_id: str) -> Interface | None:
    if role_id not in {role.id for role in manifest.roles}:
        return None
    candidates = [
        interface
        for kind in (AdapterKind.sse, AdapterKind.http)
        for interface in manifest.interfaces
        if interface.kind is kind and is_chat_interface(interface)
    ]
    served = [interface for interface in candidates if serves_role(manifest, interface.id, role_id)]
    chosen = served or candidates
    return chosen[0] if chosen else None


def chat_request_for(interface: Interface, ask: str) -> dict[str, Any]:
    described = interface.model_dump(mode="json")
    shape = chat_shape(described)
    method = str((shape or {}).get("method") or DEFAULT_ASK_METHOD)
    path = str((shape or {}).get("path") or ROOT_PATH)
    return request_document(
        method, path, str(described.get("base_path") or ""), body=chat_body(shape, ask)
    )


def placeholder_step(interface: Interface) -> dict[str, Any]:
    step: dict[str, Any] = {
        "adapter": "sse" if interface.kind is AdapterKind.sse else "http",
        "label": PLACEHOLDER_LABEL,
        "request": chat_request_for(interface, PLACEHOLDER_ASK),
    }
    if interface.kind is AdapterKind.sse:
        step["ask"] = PLACEHOLDER_ASK
    return step


def simulation_document(key: str, title: str, role: str, interface: Interface) -> dict[str, Any]:
    return {
        "schema_version": SCENARIO_SCHEMA_VERSION,
        "id": key,
        "title": title,
        "family": SIMULATION_FAMILY.value,
        "role": role,
        "interface_id": interface.id,
        "synthetic": True,
        "steps": [placeholder_step(interface)],
    }
