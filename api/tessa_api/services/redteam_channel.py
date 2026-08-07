import copy
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from tessa_api.schemas.attack_family import FamilyCodeCheck, FamilyDefinition
from tessa_api.schemas.bundle import BundleManifest
from tessa_api.schemas.enums import AdapterKind, SyntheticFamily
from tessa_api.schemas.scenario import SCENARIO_SCHEMA_VERSION
from tessa_api.services.invariant_scenarios import chat_request
from tessa_api.services.smoke_generator import chat_shape, inject_ask, truncated

REDTEAM_FAMILY = SyntheticFamily.redteam.value
SCENARIO_KEY_PREFIX = "rt"
CHANNEL_KINDS = (AdapterKind.sse, AdapterKind.http)
SSE_ANSWERED_STATUSES = [200]
HTTP_ANSWERED_STATUSES = [200, 201, 202]
PROBE_MESSAGE = "Hello"
TITLE_MAX_CHARS = 200
LABEL_MAX_CHARS = 200


@dataclass(frozen=True, slots=True)
class AttackChannel:
    interface_id: str
    kind: AdapterKind
    interface: dict[str, Any]
    shape: dict[str, Any]


def carries_message(shape: dict[str, Any]) -> bool:
    example = shape.get("request_example")
    return example is not None and inject_ask(copy.deepcopy(example), PROBE_MESSAGE)[1]


def attack_channel(manifest: BundleManifest) -> AttackChannel | None:
    for kind in CHANNEL_KINDS:
        for interface in manifest.interfaces:
            if interface.kind is not kind:
                continue
            described = interface.model_dump(mode="json")
            shape = chat_shape(described)
            if shape is None:
                continue
            if kind is AdapterKind.http and not carries_message(dict(shape)):
                continue
            return AttackChannel(interface.id, kind, described, dict(shape))
    return None


def attack_scenario_key(attack_id: UUID, replay: bool) -> str:
    return f"{SCENARIO_KEY_PREFIX}-{'replay' if replay else 'attack'}-{attack_id}"


def attack_step(
    channel: AttackChannel, family: FamilyDefinition, label: str, prompt: str
) -> dict[str, Any]:
    request = chat_request(channel.interface, channel.shape, prompt)
    checks_internal_ids = FamilyCodeCheck.internal_ids in family.code_checks
    if channel.kind is AdapterKind.sse:
        return {
            "adapter": "sse",
            "label": truncated(label, LABEL_MAX_CHARS),
            "ask": prompt,
            "request": request,
            "expect": {
                "status": list(SSE_ANSWERED_STATUSES),
                "non_empty_answer": False,
                "internal_ids": checks_internal_ids,
            },
        }
    return {
        "adapter": "http",
        "label": truncated(label, LABEL_MAX_CHARS),
        "request": request,
        "expect": {
            "status": list(HTTP_ANSWERED_STATUSES),
            "internal_ids": checks_internal_ids,
        },
    }


def attack_scenario_document(
    channel: AttackChannel,
    role: str,
    family: FamilyDefinition,
    key: str,
    title: str,
    prompt: str,
) -> dict[str, Any]:
    return {
        "schema_version": SCENARIO_SCHEMA_VERSION,
        "id": key,
        "title": truncated(title, TITLE_MAX_CHARS),
        "family": REDTEAM_FAMILY,
        "role": role,
        "interface_id": channel.interface_id,
        "synthetic": True,
        "steps": [attack_step(channel, family, f"{family.id}: {truncated(prompt, 120)}", prompt)],
    }
