import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tessa_api.schemas.bundle import BUNDLE_SCHEMA_VERSION, BundleManifest
from tessa_api.schemas.bundle_files import add_file_format_definitions
from tessa_api.schemas.findings import FINDING_REPRO_SCHEMA_VERSION, StoredFindingRepro
from tessa_api.schemas.goals import GOAL_SCHEMA_VERSION, GoalFields
from tessa_api.schemas.mutants import MUTANT_SCHEMA_VERSION, MutantFields
from tessa_api.schemas.personas import PERSONA_SCHEMA_VERSION, PersonaFields
from tessa_api.schemas.probes import PROBE_SCHEMA_VERSION, ProbeBankFile
from tessa_api.schemas.proposals import PROPOSAL_SCHEMA_VERSION, ProposalDoc
from tessa_api.schemas.registry import SchemaIndex, SchemaIndexEntry
from tessa_api.schemas.reports import REPORT_SCHEMA_VERSION, RunReport
from tessa_api.schemas.scenario import SCENARIO_SCHEMA_VERSION, ScenarioDoc
from tessa_api.schemas.schedules import SCHEDULE_SCHEMA_VERSION, ScheduleFields
from tessa_api.schemas.streams import stream_event_adapter

JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
INDEX_FILE_NAME = "index.json"
SCHEMA_CONTENT_TYPE = "application/schema+json"
SCHEMA_CACHE_CONTROL = "public, max-age=3600"


@dataclass(frozen=True, slots=True)
class SchemaDefinition:
    name: str
    version: int
    stage: int
    title: str
    description: str
    build: Callable[[], dict[str, Any]]

    @property
    def file_name(self) -> str:
        return f"{self.name}.v{self.version}.json"


@dataclass(frozen=True, slots=True)
class ServedSchema:
    body: bytes
    sha256: str
    etag: str


def title_every_property(schema: dict[str, Any]) -> None:
    nodes = [schema, *schema.get("$defs", {}).values()]
    for node in nodes:
        for name, property_schema in node.get("properties", {}).items():
            property_schema.setdefault("title", property_schema.get("x-ui", {}).get("label", name))


def build_bundle_schema() -> dict[str, Any]:
    schema = BundleManifest.model_json_schema(by_alias=True, mode="validation")
    add_file_format_definitions(schema)
    title_every_property(schema)
    return schema


def build_scenario_schema() -> dict[str, Any]:
    schema = ScenarioDoc.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_stream_event_schema() -> dict[str, Any]:
    return stream_event_adapter.json_schema(by_alias=True, mode="validation")


def build_probe_schema() -> dict[str, Any]:
    schema = ProbeBankFile.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_finding_schema() -> dict[str, Any]:
    schema = StoredFindingRepro.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_persona_schema() -> dict[str, Any]:
    schema = PersonaFields.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_goal_schema() -> dict[str, Any]:
    schema = GoalFields.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_mutant_schema() -> dict[str, Any]:
    schema = MutantFields.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_schedule_schema() -> dict[str, Any]:
    schema = ScheduleFields.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_report_schema() -> dict[str, Any]:
    schema = RunReport.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


def build_proposal_schema() -> dict[str, Any]:
    schema = ProposalDoc.model_json_schema(by_alias=True, mode="validation")
    title_every_property(schema)
    return schema


SCHEMAS: tuple[SchemaDefinition, ...] = (
    SchemaDefinition(
        name="bundle",
        version=BUNDLE_SCHEMA_VERSION,
        stage=0,
        title="Tessa bundle manifest",
        description="Schema of manifest.yaml in a Tessa bundle.",
        build=build_bundle_schema,
    ),
    SchemaDefinition(
        name="stream-event",
        version=1,
        stage=0,
        title="Tessa stream event",
        description="Envelope and payload union of every event on the run stream.",
        build=build_stream_event_schema,
    ),
    SchemaDefinition(
        name="scenario",
        version=SCENARIO_SCHEMA_VERSION,
        stage=2,
        title="Tessa scenario",
        description="Schema of one scenario document: header and ordered steps with expectations.",
        build=build_scenario_schema,
    ),
    SchemaDefinition(
        name="probe",
        version=PROBE_SCHEMA_VERSION,
        stage=4,
        title="Tessa probe bank",
        description="Schema of a probes/*.yaml file: typed Laya questions about short texts.",
        build=build_probe_schema,
    ),
    SchemaDefinition(
        name="finding",
        version=FINDING_REPRO_SCHEMA_VERSION,
        stage=5,
        title="Tessa finding repro bundle",
        description="Stored form of a finding's repro bundle: artifact ids, never signed URLs.",
        build=build_finding_schema,
    ),
    SchemaDefinition(
        name="persona",
        version=PERSONA_SCHEMA_VERSION,
        stage=7,
        title="Tessa persona",
        description="Fields of a simulated user persona: name, description and a closed set of "
        "traits.",
        build=build_persona_schema,
    ),
    SchemaDefinition(
        name="goal",
        version=GOAL_SCHEMA_VERSION,
        stage=7,
        title="Tessa goal",
        description="Fields of a goal for a simulated user or an explorer, with the success "
        "criteria grammar: db:, tool:, text: and judge: prefixes, unprefixed means judge:.",
        build=build_goal_schema,
    ),
    SchemaDefinition(
        name="mutant",
        version=MUTANT_SCHEMA_VERSION,
        stage=8,
        title="Tessa mutant",
        description="One known bug: a branch with a single deliberate defect and the invariants "
        "that should catch it; also one entry of the bundle sidecar tessa/mutants.yaml.",
        build=build_mutant_schema,
    ),
    SchemaDefinition(
        name="schedule",
        version=SCHEDULE_SCHEMA_VERSION,
        stage=8,
        title="Tessa schedule",
        description="A recurring run of one saved plan: when it fires, how much it may spend "
        "and who hears about it.",
        build=build_schedule_schema,
    ),
    SchemaDefinition(
        name="report",
        version=REPORT_SCHEMA_VERSION,
        stage=8,
        title="Tessa run report",
        description="JSON report of one run: the run, its stats, findings, the diff against the "
        "previous run and the frozen configuration.",
        build=build_report_schema,
    ),
    SchemaDefinition(
        name="proposal",
        version=PROPOSAL_SCHEMA_VERSION,
        stage=11,
        title="Tessa test proposal",
        description="The tessa/proposal.yaml file: what is worth testing in an app, ranked "
        "by risk, with the reasons and what each test needs.",
        build=build_proposal_schema,
    ),
)


def find_definition(name: str, version: int) -> SchemaDefinition | None:
    for definition in SCHEMAS:
        if definition.name == name and definition.version == version:
            return definition
    return None


def build_schema_document(definition: SchemaDefinition) -> dict[str, Any]:
    generated = definition.build()
    title = generated.pop("title", definition.title)
    description = generated.pop("description", definition.description)
    return {
        "$schema": JSON_SCHEMA_DIALECT,
        "$id": definition.file_name,
        "title": title,
        "description": description,
        **generated,
    }


def render_json(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def schema_url(public_api_url: str, definition: SchemaDefinition) -> str:
    return f"{public_api_url}/schemas/{definition.file_name}"


def build_committed_index(rendered_documents: dict[str, str]) -> SchemaIndex:
    return SchemaIndex(
        schemas=[
            SchemaIndexEntry(
                name=definition.name,
                version=definition.version,
                url=definition.file_name,
                sha256=sha256_hex(rendered_documents[definition.file_name].encode("utf-8")),
                stage=definition.stage,
            )
            for definition in SCHEMAS
        ]
    )


def render_committed_files() -> dict[str, str]:
    documents = {
        definition.file_name: render_json(build_schema_document(definition))
        for definition in SCHEMAS
    }
    index = build_committed_index(documents)
    documents[INDEX_FILE_NAME] = render_json(index.model_dump(mode="json"))
    return documents


def etag_matches(header: str | None, etag: str) -> bool:
    if header is None:
        return False
    candidates = [part.strip() for part in header.split(",")]
    if "*" in candidates:
        return True
    return any(candidate.removeprefix("W/") == etag for candidate in candidates)


class SchemaStore:
    def __init__(self, schemas_dir: Path, public_api_url: str) -> None:
        self._schemas_dir = schemas_dir
        self._public_api_url = public_api_url

    def serve(self, definition: SchemaDefinition) -> ServedSchema:
        committed = json.loads((self._schemas_dir / definition.file_name).read_text("utf-8"))
        committed["$id"] = schema_url(self._public_api_url, definition)
        body = render_json(committed).encode("utf-8")
        digest = sha256_hex(body)
        return ServedSchema(body=body, sha256=digest, etag=f'"{digest}"')

    def index(self) -> SchemaIndex:
        return SchemaIndex(
            schemas=[
                SchemaIndexEntry(
                    name=definition.name,
                    version=definition.version,
                    url=schema_url(self._public_api_url, definition),
                    sha256=self.serve(definition).sha256,
                    stage=definition.stage,
                )
                for definition in SCHEMAS
            ]
        )
