import copy
import hashlib
import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import yaml
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessa_api.db.models import BundleRow, CoverageCellRow, PlanRow, ScenarioRow
from tessa_api.errors import not_found
from tessa_api.ids import new_id
from tessa_api.schemas.bundle_files import Flow, FlowStep
from tessa_api.schemas.enums import (
    AdapterKind,
    CellStatus,
    ScenarioOrigin,
    ScenarioStatus,
)
from tessa_api.services.cell_rules import LIVE_SCENARIO_STATUSES
from tessa_api.services.cell_status import settle_scenario_cells
from tessa_api.services.manifest_loader import load_yaml_document
from tessa_api.services.plan_builder import SUPPORTED_ADAPTER_KINDS, mapping_items
from tessa_api.services.scenario_library import (
    apply_check,
    scenario_view_for_bundle,
    status_after_validation,
)
from tessa_api.services.scenario_records import provenance_row, version_row
from tessa_api.services.scenario_validator import (
    ScenarioBundleView,
    ScenarioCheck,
    validate_scenario_text,
)
from tessa_api.services.storage import BundleStore

FLOWS_FOLDER = "flows/"
YAML_SUFFIXES = (".yaml", ".yml")
MAX_FLOW_BYTES = 256 * 1024
HTTP_SUCCESS_STATUSES = (200, 201, 202, 204)
HTTP_MAX_LATENCY_MS = 10_000
SSE_SUCCESS_STATUS = 200
SSE_MAX_FIRST_BYTE_MS = 30_000
SSE_MAX_TOTAL_MS = 120_000
CONSOLE_ALLOWED_PATTERNS = ("favicon\\.ico",)
ASK_FIELD_NAMES = ("message", "text", "prompt", "question", "query", "input", "content", "ask", "q")
DEFAULT_ASK_FIELD = "message"
DEFAULT_HTTP_METHOD = "GET"
DEFAULT_ASK_METHOD = "POST"
ROOT_PATH = "/"
TITLE_MAX_LENGTH = 200
LABEL_MAX_LENGTH = 200
SMOKE_GENERATOR = "smoke"
SOURCE_EXAMPLE = "example"
SOURCE_FLOW = "flow"
SCHEMA_VERSION = 1


@dataclass(frozen=True, slots=True)
class ExampleSource:
    index: int
    example: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class FlowSource:
    flow: Flow


SmokeSource = ExampleSource | FlowSource


@dataclass(frozen=True, slots=True)
class SmokeBundleView:
    features: Mapping[str, Mapping[str, Any]]
    interfaces: Mapping[str, Mapping[str, Any]]
    flows: tuple[Flow, ...]


@dataclass(frozen=True, slots=True)
class SmokeGeneration:
    cell_id: uuid.UUID
    scenario_ids: tuple[uuid.UUID, ...]
    created: int
    reused: int
    invalid: int


def build_smoke_view(manifest: Mapping[str, Any] | None, flows: Sequence[Flow]) -> SmokeBundleView:
    manifest = manifest or {}
    return SmokeBundleView(
        features={
            str(feature["id"]): feature
            for feature in mapping_items(manifest.get("features"))
            if feature.get("id")
        },
        interfaces={
            str(interface["id"]): interface
            for interface in mapping_items(manifest.get("interfaces"))
            if interface.get("id")
        },
        flows=tuple(flows),
    )


def flow_paths(bundle: BundleRow) -> list[str]:
    return sorted(
        str(entry["path"])
        for entry in bundle.files
        if isinstance(entry.get("path"), str)
        and str(entry["path"]).startswith(FLOWS_FOLDER)
        and "/" not in str(entry["path"])[len(FLOWS_FOLDER) :]
        and str(entry["path"]).endswith(YAML_SUFFIXES)
    )


async def load_bundle_flows(store: BundleStore, bundle: BundleRow) -> list[Flow]:
    if bundle.storage_path is None:
        return []
    flows: list[Flow] = []
    for path in flow_paths(bundle):
        raw = await store.read(bundle.storage_path, path, MAX_FLOW_BYTES + 1)
        if raw is None or len(raw) > MAX_FLOW_BYTES:
            continue
        loaded = load_yaml_document(raw.decode("utf-8", errors="replace"), path)
        if loaded.data is None:
            continue
        try:
            flows.append(Flow.model_validate(loaded.data))
        except ValueError:
            continue
    return flows


def request_of(example: Mapping[str, Any]) -> Mapping[str, Any] | None:
    request = example.get("request")
    return request if isinstance(request, Mapping) and request.get("path") else None


def ask_of(example: Mapping[str, Any]) -> str | None:
    ask = example.get("ask")
    return ask if isinstance(ask, str) and ask.strip() else None


def shapes_of(interface: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return list(mapping_items(interface.get("shapes")))


def chat_shape(interface: Mapping[str, Any]) -> Mapping[str, Any] | None:
    shapes = shapes_of(interface)
    for shape in shapes:
        method = str(shape.get("method") or "").upper()
        if shape.get("request_example") is not None and method in ("", DEFAULT_ASK_METHOD):
            return shape
    return shapes[0] if shapes else None


def smoke_sources(
    view: SmokeBundleView, feature_id: str, role: str, interface_id: str
) -> list[SmokeSource]:
    feature = view.features.get(feature_id)
    interface = view.interfaces.get(interface_id)
    if feature is None or interface is None:
        return []
    try:
        kind = AdapterKind(str(interface.get("kind")))
    except ValueError:
        return []
    if kind is AdapterKind.browser:
        return [
            FlowSource(flow)
            for flow in view.flows
            if feature_id in flow.feature_ids and flow.role == role
        ]
    examples = list(enumerate(mapping_items(feature.get("examples"))))
    if kind is AdapterKind.sse:
        return [
            ExampleSource(index, example)
            for index, example in examples
            if ask_of(example) or request_of(example)
        ]
    if kind is AdapterKind.http:
        has_shape = chat_shape(interface) is not None
        return [
            ExampleSource(index, example)
            for index, example in examples
            if request_of(example) or (ask_of(example) and has_shape)
        ]
    return []


def strip_base_path(path: str, base_path: str) -> str:
    candidate = path if path.startswith("/") else f"/{path}"
    base = base_path.rstrip("/")
    if not base.startswith("/") or base == "":
        return candidate
    if candidate == base:
        return ROOT_PATH
    if candidate.startswith(f"{base}/"):
        return candidate[len(base) :]
    return candidate


def inject_ask(template: Any, ask: str) -> tuple[Any, bool]:
    if isinstance(template, str):
        return ask, True
    if isinstance(template, dict):
        copied = dict(template)
        for key in ASK_FIELD_NAMES:
            if isinstance(copied.get(key), str):
                copied[key] = ask
                return copied, True
        for key, value in copied.items():
            replaced, done = (
                inject_ask(value, ask) if isinstance(value, dict | list) else (value, False)
            )
            if done:
                copied[key] = replaced
                return copied, True
        return copied, False
    if isinstance(template, list):
        items = list(template)
        for index, value in enumerate(items):
            replaced, done = (
                inject_ask(value, ask) if isinstance(value, dict | list) else (value, False)
            )
            if done:
                items[index] = replaced
                return items, True
        return items, False
    return template, False


def chat_body(shape: Mapping[str, Any] | None, ask: str) -> Any:
    template = copy.deepcopy(shape.get("request_example")) if shape is not None else None
    if template is None:
        return {DEFAULT_ASK_FIELD: ask}
    body, injected = inject_ask(template, ask)
    if injected:
        return body
    if isinstance(body, dict):
        return {**body, DEFAULT_ASK_FIELD: ask}
    return {DEFAULT_ASK_FIELD: ask}


def string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): str(item) for key, item in value.items()}


def request_document(
    method: str,
    path: str,
    base_path: str,
    headers: Any = None,
    query: Any = None,
    body: Any = None,
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "method": method.upper(),
        "path": strip_base_path(path, base_path),
    }
    header_map = string_map(headers)
    if header_map:
        document["headers"] = header_map
    if isinstance(query, Mapping) and query:
        document["query"] = dict(query)
    if body is not None:
        document["body"] = body
    return document


def truncated(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else f"{collapsed[: limit - 1]}…"


def literal_texts(example: Mapping[str, Any]) -> list[str]:
    value = example.get("text_contains")
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return []


def expected_text(example: Mapping[str, Any]) -> str | None:
    expected = example.get("expected")
    return expected.strip() if isinstance(expected, str) and expected.strip() else None


def request_for_example(
    example: Mapping[str, Any], interface: Mapping[str, Any]
) -> tuple[dict[str, Any], str] | None:
    base_path = str(interface.get("base_path") or "")
    request = request_of(example)
    if request is not None:
        document = request_document(
            str(request.get("method") or DEFAULT_HTTP_METHOD),
            str(request["path"]),
            base_path,
            request.get("headers"),
            request.get("query"),
            request.get("body"),
        )
        return document, f"{document['method']} {document['path']}"
    ask = ask_of(example)
    if ask is None:
        return None
    shape = chat_shape(interface)
    method = (
        str(shape.get("method") or DEFAULT_ASK_METHOD) if shape is not None else DEFAULT_ASK_METHOD
    )
    path = str(shape.get("path") or ROOT_PATH) if shape is not None else ROOT_PATH
    document = request_document(method, path, base_path, body=chat_body(shape, ask))
    return document, ask


def sse_step(example: Mapping[str, Any], interface: Mapping[str, Any]) -> dict[str, Any] | None:
    built = request_for_example(example, interface)
    if built is None:
        return None
    request, headline = built
    expect: dict[str, Any] = {
        "status": SSE_SUCCESS_STATUS,
        "non_empty_answer": True,
        "internal_ids": True,
        "latency": {"max_first_byte_ms": SSE_MAX_FIRST_BYTE_MS, "max_ms": SSE_MAX_TOTAL_MS},
    }
    literals = literal_texts(example)
    if literals:
        expect["text_contains"] = literals
    prose = expected_text(example)
    if prose is not None:
        expect["free_text"] = prose
    step: dict[str, Any] = {
        "adapter": "sse",
        "label": truncated(headline, LABEL_MAX_LENGTH),
        "request": request,
        "expect": expect,
    }
    ask = ask_of(example)
    if ask is not None:
        step["ask"] = ask
    return step


def http_step(example: Mapping[str, Any], interface: Mapping[str, Any]) -> dict[str, Any] | None:
    built = request_for_example(example, interface)
    if built is None:
        return None
    request, headline = built
    expect: dict[str, Any] = {
        "status": list(HTTP_SUCCESS_STATUSES),
        "internal_ids": True,
        "latency": {"max_ms": HTTP_MAX_LATENCY_MS},
    }
    prose = expected_text(example)
    if prose is not None:
        expect["free_text"] = prose
    return {
        "adapter": "http",
        "label": truncated(headline, LABEL_MAX_LENGTH),
        "request": request,
        "expect": expect,
    }


def text_list(value: Any) -> list[str]:
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item]
    return []


def target_document(value: Any) -> dict[str, str] | None:
    if not isinstance(value, Mapping):
        return None
    document = {
        key: str(value[key]) for key in ("role", "name", "selector") if value.get(key) is not None
    }
    return document or None


def target_list(value: Any) -> list[dict[str, str]]:
    items = value if isinstance(value, list) else [value]
    return [document for item in items if (document := target_document(item)) is not None]


def dom_state_of(expect: Mapping[str, Any]) -> dict[str, Any]:
    dom_state: dict[str, Any] = {}
    if isinstance(expect.get("url"), str) and expect["url"]:
        dom_state["url"] = expect["url"]
    title = expect.get("title_contains") or expect.get("title")
    if isinstance(title, str) and title:
        dom_state["title_contains"] = title
    contains = text_list(expect.get("text_contains") or expect.get("text"))
    if contains:
        dom_state["text_contains"] = contains
    excluded = text_list(
        expect.get("text_not_contains") or expect.get("text_not") or expect.get("not_text")
    )
    if excluded:
        dom_state["text_not_contains"] = excluded
    visible = target_list(expect.get("visible"))
    if visible:
        dom_state["visible"] = visible
    hidden = target_list(expect.get("hidden"))
    if hidden:
        dom_state["hidden"] = hidden
    return dom_state


def step_label(step: FlowStep) -> str:
    if step.target is not None:
        subject = step.target.selector or f"{step.target.role} {step.target.name}"
        return truncated(f"{step.action} {subject}", LABEL_MAX_LENGTH)
    if step.url is not None:
        return truncated(f"{step.action} {step.url}", LABEL_MAX_LENGTH)
    return truncated(f"{step.action} {step.value or ''}".strip(), LABEL_MAX_LENGTH)


def flow_step_document(step: FlowStep, last: bool, prose: str | None) -> dict[str, Any]:
    document: dict[str, Any] = {
        "adapter": "browser",
        "label": step_label(step),
        "action": step.action,
    }
    if step.url is not None:
        document["url"] = step.url
    target = target_document(step.target.model_dump(exclude_none=True) if step.target else None)
    if target is not None:
        document["target"] = target
    if step.value is not None:
        document["value"] = step.value
    expect: dict[str, Any] = {}
    dom_state = dom_state_of(step.expect)
    if dom_state:
        expect["dom_state"] = dom_state
    if last:
        expect["console"] = {"fail_on": ["error"], "allow": list(CONSOLE_ALLOWED_PATTERNS)}
        if prose is not None:
            expect["free_text"] = prose
    if expect:
        document["expect"] = expect
    return document


def flow_prose(view: SmokeBundleView, feature_id: str) -> str | None:
    feature = view.features.get(feature_id)
    if feature is None:
        return None
    for example in mapping_items(feature.get("examples")):
        prose = expected_text(example)
        if prose is not None:
            return prose
    return None


def browser_steps(flow: Flow, prose: str | None) -> list[dict[str, Any]]:
    last_index = len(flow.steps) - 1
    return [
        flow_step_document(step, index == last_index, prose)
        for index, step in enumerate(flow.steps)
    ]


def smoke_steps(
    view: SmokeBundleView, feature_id: str, interface_id: str, source: SmokeSource
) -> tuple[str, list[dict[str, Any]]] | None:
    interface = view.interfaces[interface_id]
    if isinstance(source, FlowSource):
        steps = browser_steps(source.flow, flow_prose(view, feature_id))
        return source.flow.title, steps
    if interface.get("kind") == AdapterKind.sse:
        step = sse_step(source.example, interface)
    else:
        step = http_step(source.example, interface)
    if step is None:
        return None
    return str(step["label"]), [step]


def smoke_document(
    view: SmokeBundleView,
    feature_id: str,
    family: str,
    role: str,
    interface_id: str,
    source: SmokeSource,
) -> dict[str, Any] | None:
    built = smoke_steps(view, feature_id, interface_id, source)
    if built is None:
        return None
    headline, steps = built
    suffix = f" ({role} on {interface_id})"
    return {
        "schema_version": SCHEMA_VERSION,
        "title": truncated(headline, TITLE_MAX_LENGTH - len(suffix)) + suffix,
        "feature_id": feature_id,
        "family": family,
        "role": role,
        "interface_id": interface_id,
        "steps": steps,
    }


def document_hash(document: Mapping[str, Any]) -> str:
    canonical = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def document_yaml(document: Mapping[str, Any]) -> str:
    return yaml.safe_dump(dict(document), sort_keys=False, allow_unicode=True, width=100)


def source_provenance(source: SmokeSource) -> dict[str, Any]:
    if isinstance(source, FlowSource):
        return {"source": SOURCE_FLOW, "flow_id": source.flow.id}
    return {"source": SOURCE_EXAMPLE, "example_index": source.index}


async def lock_target_generation(session: AsyncSession, target_id: uuid.UUID) -> None:
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"smoke:{target_id}"},
    )


async def find_existing(
    session: AsyncSession,
    target_id: uuid.UUID,
    feature_id: str,
    role: str,
    interface_id: str,
    example_hash: str,
) -> ScenarioRow | None:
    return await session.scalar(
        select(ScenarioRow)
        .where(
            ScenarioRow.target_id == target_id,
            ScenarioRow.feature_id == feature_id,
            ScenarioRow.origin == ScenarioOrigin.bundle_example,
            ScenarioRow.provenance.contains(
                {"role": role, "interface_id": interface_id, "example_hash": example_hash}
            ),
        )
        .order_by(ScenarioRow.created_at, ScenarioRow.id)
        .limit(1)
    )


def new_scenario_row(
    bundle: BundleRow,
    cell: CoverageCellRow,
    document: Mapping[str, Any],
    check: ScenarioCheck,
    provenance: dict[str, Any],
) -> ScenarioRow:
    return ScenarioRow(
        id=new_id(),
        target_id=bundle.target_id,
        bundle_id=bundle.id,
        feature_id=cell.feature_id,
        cell_id=cell.id,
        title=str(document["title"]),
        family=cell.family,
        origin=ScenarioOrigin.bundle_example,
        status=status_after_validation(
            ScenarioOrigin.bundle_example, ScenarioStatus.validating, check.validation.valid
        ),
        version=1,
        yaml=document_yaml(document),
        parsed=check.parsed if check.parsed is not None else dict(document),
        validation=check.validation.model_dump(mode="json"),
        provenance=provenance,
    )


def smoke_provenance(
    bundle: BundleRow, cell: CoverageCellRow, example_hash: str, source: SmokeSource
) -> dict[str, Any]:
    return {
        "generator": SMOKE_GENERATOR,
        "role": cell.role,
        "interface_id": cell.interface_id,
        "example_hash": example_hash,
        "bundle_version": bundle.version,
        **source_provenance(source),
    }


def supported_interface(view: SmokeBundleView, interface_id: str) -> bool:
    interface = view.interfaces.get(interface_id)
    if interface is None:
        return False
    try:
        return AdapterKind(str(interface.get("kind"))) in SUPPORTED_ADAPTER_KINDS
    except ValueError:
        return False


async def load_generation_inputs(
    session: AsyncSession, store: BundleStore, cell_id: uuid.UUID
) -> tuple[CoverageCellRow, BundleRow, SmokeBundleView]:
    cell = await session.get(CoverageCellRow, cell_id)
    if cell is None:
        raise not_found("Coverage cell not found")
    plan = await session.get(PlanRow, cell.plan_id)
    bundle = await session.get(BundleRow, plan.bundle_id) if plan is not None else None
    if bundle is None:
        raise not_found("The plan of the coverage cell or its bundle no longer exists")
    flows = await load_bundle_flows(store, bundle)
    return cell, bundle, build_smoke_view(bundle.manifest, flows)


@dataclass(slots=True)
class GenerationTally:
    ids: list[uuid.UUID] = field(default_factory=list)
    created: int = 0
    reused: int = 0

    def add(self, row: ScenarioRow, created: bool) -> None:
        self.ids.append(row.id)
        if created:
            self.created += 1
        else:
            self.reused += 1


async def reuse_or_create(
    session: AsyncSession,
    bundle: BundleRow,
    cell: CoverageCellRow,
    scenario_view: ScenarioBundleView,
    document: Mapping[str, Any],
    source: SmokeSource,
) -> tuple[ScenarioRow, bool]:
    example_hash = document_hash(document)
    existing = await find_existing(
        session, bundle.target_id, cell.feature_id, cell.role, cell.interface_id, example_hash
    )
    if existing is not None:
        if existing.status is ScenarioStatus.invalid:
            apply_check(existing, validate_scenario_text(existing.yaml, scenario_view))
        return existing, False
    check = validate_scenario_text(document_yaml(document), scenario_view)
    provenance = smoke_provenance(bundle, cell, example_hash, source)
    row = new_scenario_row(bundle, cell, document, check, provenance)
    session.add(row)
    await session.flush()
    session.add(version_row(row, None, None))
    session.add(provenance_row(row, bundle))
    await session.flush()
    return row, True


def smoke_failure_reason(rows: Sequence[ScenarioRow]) -> str:
    for row in rows:
        errors = row.validation.get("errors") or []
        if errors and isinstance(errors[0], dict) and errors[0].get("message"):
            return f"The generated smoke scenario is invalid: {errors[0]['message']}"
    return "The bundle has no example or flow to build a smoke scenario for this cell from"


async def generate_smoke_scenarios(
    session: AsyncSession, store: BundleStore, cell_id: uuid.UUID
) -> SmokeGeneration:
    cell, bundle, view = await load_generation_inputs(session, store, cell_id)
    if not supported_interface(view, cell.interface_id):
        return SmokeGeneration(cell.id, (), 0, 0, 0)
    scenario_view = await scenario_view_for_bundle(session, bundle.target_id, bundle.id)
    await lock_target_generation(session, bundle.target_id)
    tally = GenerationTally()
    rows: dict[uuid.UUID, ScenarioRow] = {}
    seen_hashes: set[str] = set()
    for source in smoke_sources(view, cell.feature_id, cell.role, cell.interface_id):
        document = smoke_document(
            view, cell.feature_id, cell.family, cell.role, cell.interface_id, source
        )
        if document is None or document_hash(document) in seen_hashes:
            continue
        seen_hashes.add(document_hash(document))
        row, created = await reuse_or_create(session, bundle, cell, scenario_view, document, source)
        tally.add(row, created)
        rows[row.id] = row
    invalid = sum(1 for row in rows.values() if row.status is ScenarioStatus.invalid)
    await settle_scenario_cells(
        session, bundle.target_id, [(cell.feature_id, cell.role, cell.interface_id)]
    )
    if cell.status in (CellStatus.empty, CellStatus.generated, CellStatus.needs_author) and not any(
        row.status in LIVE_SCENARIO_STATUSES for row in rows.values()
    ):
        cell.status = CellStatus.needs_author
        cell.reason = smoke_failure_reason(list(rows.values()))
    await session.flush()
    return SmokeGeneration(
        cell_id=cell.id,
        scenario_ids=tuple(tally.ids),
        created=tally.created,
        reused=tally.reused,
        invalid=invalid,
    )


def count_smoke_scenarios(view: SmokeBundleView, cells: Sequence[tuple[str, str, str]]) -> int:
    return sum(
        len(smoke_sources(view, feature, role, interface)) for feature, role, interface in cells
    )
