from typing import Any, Literal, Self

from pydantic import BaseModel, model_validator

from tessa_api.schemas.bundle import (
    ENV_TEMPLATE_LINE_PATTERN,
    SLUG_PATTERN,
    manifest_field,
    section_config,
)
from tessa_api.schemas.bundle_references import ManifestProblem, to_validation_error
from tessa_api.schemas.mutants import MUTANTS_SIDECAR_MAX_ENTRIES, MutantFields

ORACLE_NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]*$"
GOLD_KEY_PATTERN = r"^[a-z][a-z0-9_]*$"
PARAM_SOURCES = ("clock", "tenant", "role", "literal")
PARAM_SOURCE_KEY = "x-source"

FlowAction = Literal["goto", "click", "fill", "press", "select", "check", "hover", "wait_for"]
ACTIONS_NEEDING_URL = frozenset({"goto"})
ACTIONS_NEEDING_TARGET = frozenset({"click", "fill", "select", "check", "hover"})
ACTIONS_NEEDING_VALUE = frozenset({"fill", "press", "select"})

ENV_TEMPLATE_DESCRIPTION = (
    "Format of env.template: plain text, one variable per line as NAME=value, where NAME matches "
    "[A-Z][A-Z0-9_]* and value is empty or a single token without whitespace (use <describe-it> "
    "for a secret, or a harmless example for a non-secret). The purpose of a variable goes in a "
    "comment line starting with # directly above it, or in a trailing comment after whitespace "
    "and #. Blank lines are allowed. Every environment entry of the manifest has exactly one "
    "line, and no other names appear. Never put a real value in this file."
)
MUTANTS_SIDECAR_DESCRIPTION = (
    "Format of the optional file mutants.yaml: one YAML list, one entry per known bug, each "
    "validated against MutantFields. Upload imports every entry as a mutant with status "
    "registered; an entry is identified by its name, so uploading the same name again updates "
    "it instead of adding a second one."
)
ENV_TEMPLATE_EXAMPLE = (
    "# Base URL of the QA deployment\n"
    "GRACIE_BASE_URL=http://localhost:8080\n"
    "\n"
    "ADMIN_TOKEN=<admin-api-token>  # API token of the admin role\n"
)


class OracleGoldPoint(BaseModel):
    model_config = section_config(
        "Oracle gold point",
        "One named value Tessa derives from the oracle rows and interpolates into the "
        "expected result of a step as ${gold.<key>}.",
        "allow",
    )

    key: str = manifest_field(
        "Key",
        "Lower case name used in ${gold.<key>}.",
        ["open_count"],
        "Oracle",
        1,
        pattern=GOLD_KEY_PATTERN,
    )
    expression: str = manifest_field(
        "Expression",
        "Jinja2 expression over rows (list of row objects keyed by column name) and params that "
        "computes the value.",
        ["rows | length"],
        "Oracle",
        2,
        min_length=1,
    )
    template: str | None = manifest_field(
        "Template",
        "Jinja2 template over value, rows and params that renders the value as text; when absent "
        "the value is rendered as is.",
        ["{{ value }} open maintenance issues"],
        "Oracle",
        3,
        default=None,
    )


class OracleSidecar(BaseModel):
    model_config = section_config(
        "Oracle sidecar",
        "Format of oracle/<name>.yaml: describes the read-only reference query in "
        "oracle/<name>.sql or oracle/<name>.py that sits next to it, its parameters and the "
        "sentence Tessa expects the app to say from the rows.",
        "allow",
    )

    name: str = manifest_field(
        "Name",
        "Name of the oracle, equal to the file name without extension; features cite it in "
        "examples[].oracle.",
        ["open_maintenance"],
        "Oracle",
        1,
        pattern=ORACLE_NAME_PATTERN,
    )
    feature_ids: list[str] = manifest_field(
        "Feature ids",
        "Ids of the features whose expected result this oracle computes.",
        [["smart_log.read.open_maintenance"]],
        "Oracle",
        2,
        "chips",
        min_length=1,
    )
    language: Literal["sql", "python"] = manifest_field(
        "Language",
        "sql for oracle/<name>.sql (one SELECT, named parameters written :name); python for "
        "oracle/<name>.py defining run(params, connect) that returns a list of row objects.",
        ["sql"],
        "Oracle",
        3,
        "select",
    )
    params_schema: dict[str, Any] = manifest_field(
        "Parameters schema",
        "JSON Schema of the parameters: type object with a properties map. A property may carry "
        "x-source to say what supplies it: clock (the run's date or time), tenant (the id of the "
        "seeded QA tenant), role (the role id the scenario runs as) or literal (a fixed value "
        "given in default).",
        [
            {
                "type": "object",
                "properties": {
                    "tenant_id": {"type": "string", "x-source": "tenant"},
                    "today": {"type": "string", "format": "date", "x-source": "clock"},
                },
                "required": ["tenant_id", "today"],
            }
        ],
        "Oracle",
        4,
        "yaml",
    )
    sentence_template: str = manifest_field(
        "Sentence template",
        "Jinja2 template over rows (list of row objects keyed by column name) and params that "
        "renders the sentence the app is expected to say.",
        [
            "{{ rows | length }} maintenance issues are open, most of them in room "
            "{{ rows[0].room }}."
        ],
        "Oracle",
        5,
        "textarea",
        min_length=1,
    )
    truth_source: str | None = manifest_field(
        "Truth source",
        "Id of the truth source the query runs on; optional when the manifest declares exactly "
        "one.",
        ["primary_db"],
        "Oracle",
        6,
        default=None,
    )
    gold_points: list[OracleGoldPoint] = manifest_field(
        "Gold points",
        "Named values derived from the rows that scenarios may interpolate as ${gold.<key>}.",
        [[{"key": "open_count", "expression": "rows | length"}]],
        "Oracle",
        7,
        "yaml",
        default_factory=list,
    )

    @model_validator(mode="after")
    def parameters_are_well_formed(self) -> Self:
        problems: list[ManifestProblem] = []
        if self.params_schema.get("type") != "object":
            problems.append(
                ManifestProblem(
                    code="params_schema_not_object",
                    message="params_schema must be a JSON Schema with type: object",
                    loc=("params_schema", "type"),
                    value=self.params_schema.get("type"),
                )
            )
        properties = self.params_schema.get("properties", {})
        if not isinstance(properties, dict):
            problems.append(
                ManifestProblem(
                    code="params_schema_properties_invalid",
                    message="params_schema.properties must be a mapping of parameter names",
                    loc=("params_schema", "properties"),
                )
            )
            properties = {}
        for parameter, definition in properties.items():
            source = definition.get(PARAM_SOURCE_KEY) if isinstance(definition, dict) else None
            if source is not None and source not in PARAM_SOURCES:
                problems.append(
                    ManifestProblem(
                        code="unknown_param_source",
                        message=f"{PARAM_SOURCE_KEY} of parameter {parameter!r} must be one of "
                        f"{', '.join(PARAM_SOURCES)}",
                        loc=("params_schema", "properties", str(parameter), PARAM_SOURCE_KEY),
                        value=source,
                    )
                )
        required = self.params_schema.get("required", [])
        if isinstance(required, list):
            problems.extend(
                ManifestProblem(
                    code="required_param_not_declared",
                    message=f"Required parameter {name!r} is not in params_schema.properties",
                    loc=("params_schema", "required", position),
                    value=name,
                )
                for position, name in enumerate(required)
                if name not in properties
            )
        if problems:
            raise to_validation_error("OracleSidecar", problems)
        return self


class FlowTarget(BaseModel):
    model_config = section_config(
        "Flow target",
        "The element a step acts on: an accessibility role with its name, or a stable selector.",
        "allow",
    )

    role: str | None = manifest_field(
        "Role",
        "Accessibility role of the element, for example button, link, textbox or heading.",
        ["button"],
        "Flow",
        1,
        default=None,
    )
    name: str | None = manifest_field(
        "Name",
        "Accessible name of the element, as a screen reader announces it.",
        ["Save"],
        "Flow",
        2,
        default=None,
    )
    selector: str | None = manifest_field(
        "Selector",
        "Stable selector such as [data-testid=save], used when role and name are not enough.",
        ["[data-testid=save]"],
        "Flow",
        3,
        default=None,
    )

    @model_validator(mode="after")
    def names_the_element_one_way(self) -> Self:
        named_by_role = self.role is not None and self.name is not None
        half_a_role = (self.role is None) != (self.name is None)
        named_by_selector = self.selector is not None
        if half_a_role or named_by_role == named_by_selector:
            raise to_validation_error(
                "FlowTarget",
                [
                    ManifestProblem(
                        code="target_ambiguous",
                        message="A target is either role and name together, or a selector",
                        loc=(),
                    )
                ],
            )
        return self


class FlowStep(BaseModel):
    model_config = section_config(
        "Flow step", "One action of a UI flow and the state expected after it.", "allow"
    )

    action: FlowAction = manifest_field(
        "Action",
        "What the step does: goto opens url; click, check and hover act on target; fill and "
        "select act on target with value; press sends the key in value; wait_for only waits "
        "for expect to hold.",
        ["click"],
        "Flow",
        1,
        "select",
    )
    url: str | None = manifest_field(
        "URL",
        "Path or URL to open, for goto.",
        ["/rooms"],
        "Flow",
        2,
        default=None,
    )
    target: FlowTarget | None = manifest_field(
        "Target",
        "The element to act on.",
        [{"role": "button", "name": "Save"}],
        "Flow",
        3,
        "yaml",
        default=None,
    )
    value: str | None = manifest_field(
        "Value",
        "Text to type, option to pick or key to press. Secrets appear as ${NAME} placeholders.",
        ["${ADMIN_EMAIL}"],
        "Flow",
        4,
        default=None,
    )
    expect: dict[str, Any] = manifest_field(
        "Expect",
        "State expected after the step, for example the url, visible text or elements; an empty "
        "object when nothing is asserted.",
        [{"url": "/rooms", "text": ["Rooms"]}],
        "Flow",
        5,
        "yaml",
        default_factory=dict,
    )

    @model_validator(mode="after")
    def action_has_what_it_needs(self) -> Self:
        problems: list[ManifestProblem] = []
        if self.action in ACTIONS_NEEDING_URL and self.url is None:
            problems.append(
                ManifestProblem(
                    code="step_url_required",
                    message=f"Action {self.action} needs url",
                    loc=("url",),
                )
            )
        if self.action in ACTIONS_NEEDING_TARGET and self.target is None:
            problems.append(
                ManifestProblem(
                    code="step_target_required",
                    message=f"Action {self.action} needs target",
                    loc=("target",),
                )
            )
        if self.action in ACTIONS_NEEDING_VALUE and self.value is None:
            problems.append(
                ManifestProblem(
                    code="step_value_required",
                    message=f"Action {self.action} needs value",
                    loc=("value",),
                )
            )
        if problems:
            raise to_validation_error("FlowStep", problems)
        return self


class Flow(BaseModel):
    model_config = section_config(
        "Flow",
        "Format of flows/<id>.yaml: one key UI path as ordered steps, tied to the features it "
        "exercises.",
        "allow",
    )

    id: str = manifest_field(
        "Id",
        "Slug of the flow, equal to the file name without extension.",
        ["create_maintenance_issue"],
        "Flow",
        1,
        pattern=SLUG_PATTERN,
    )
    title: str = manifest_field(
        "Title",
        "What the path achieves, in a few words.",
        ["Create a maintenance issue from the Smart Log"],
        "Flow",
        2,
        min_length=1,
    )
    feature_ids: list[str] = manifest_field(
        "Feature ids",
        "Ids of the features this flow exercises.",
        [["smart_log.write.create_issue"]],
        "Flow",
        3,
        "chips",
        min_length=1,
    )
    role: str = manifest_field(
        "Role",
        "Id of the role the flow runs as, or anonymous before any login.",
        ["admin"],
        "Flow",
        4,
    )
    steps: list[FlowStep] = manifest_field(
        "Steps",
        "Ordered steps; the first usually opens a page with goto.",
        [[{"action": "goto", "url": "/smart-log"}]],
        "Flow",
        5,
        "yaml",
        min_length=1,
    )


def env_template_definition() -> dict[str, Any]:
    return {
        "title": "env.template",
        "description": ENV_TEMPLATE_DESCRIPTION,
        "type": "string",
        "examples": [ENV_TEMPLATE_EXAMPLE],
        "x-line-pattern": ENV_TEMPLATE_LINE_PATTERN,
    }


def mutants_sidecar_definition() -> dict[str, Any]:
    return {
        "title": "mutants.yaml",
        "description": MUTANTS_SIDECAR_DESCRIPTION,
        "type": "array",
        "items": {"$ref": f"#/$defs/{MutantFields.__name__}"},
        "maxItems": MUTANTS_SIDECAR_MAX_ENTRIES,
    }


def add_file_format_definitions(schema: dict[str, Any]) -> None:
    definitions: dict[str, Any] = schema["$defs"]
    for model in (OracleSidecar, Flow, MutantFields):
        generated = model.model_json_schema(by_alias=True, mode="validation")
        for name, definition in generated.pop("$defs", {}).items():
            if name in definitions and definitions[name] != definition:
                raise ValueError(f"definition {name} is declared twice with different content")
            definitions[name] = definition
        definitions[model.__name__] = generated
    definitions["EnvTemplate"] = env_template_definition()
    definitions["MutantsSidecar"] = mutants_sidecar_definition()
