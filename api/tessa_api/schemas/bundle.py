from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, model_validator
from pydantic.config import JsonDict

from tessa_api.schemas.bundle_references import (
    SKIP_REFERENCE_CHECKS,
    ManifestProblem,
    find_reference_problems,
    to_validation_error,
)
from tessa_api.schemas.enums import AdapterKind, AppKind, Confidence, EnvVarKind, FeatureKind

Widget = Literal["text", "textarea", "select", "chips", "yaml", "sql", "number", "toggle"]

BUNDLE_SCHEMA_VERSION = 1
SLUG_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
ENV_NAME_PATTERN = r"^[A-Z][A-Z0-9_]*$"
TARGET_TOKEN_PATTERN = r"^tgt_[a-z2-7]{22}$"
SCHEMA_URL_PATTERN = r"^https?://[^\s/]+(/\S*)?/schemas/bundle\.v1\.json$"
BUNDLE_PATH_SEGMENT = r"[A-Za-z0-9_][A-Za-z0-9_.-]*"
SEED_FILE_PATTERN = rf"^seeds(/{BUNDLE_PATH_SEGMENT})+$"
SEED_SCRIPT_PATTERN = rf"^seeds(/{BUNDLE_PATH_SEGMENT})*/{BUNDLE_PATH_SEGMENT}\.(sql|py|sh)$"
SEED_HASH_PATTERN = r"^[A-Za-z0-9:_-]{8,128}$"
DIALECT_PATTERN = r"^[a-z][a-z0-9_]*$"
ENV_TEMPLATE_LINE_PATTERN = r"^([A-Z][A-Z0-9_]*)=(\S*)(\s+#\s*(.*))?$"
COMMIT_PATTERN = r"^[0-9a-f]{7,40}$"
ALWAYS_SECRET_KINDS = frozenset({EnvVarKind.dsn, EnvVarKind.token, EnvVarKind.password})
HMAC_SHA256_AUTH_TYPE = "hmac_sha256"

TcpPort = Annotated[int, Field(ge=1, le=65535)]
FixturePath = Annotated[str, Field(pattern=SEED_FILE_PATTERN)]


def manifest_field(
    title: str,
    description: str,
    examples: list[Any],
    group: str,
    order: int,
    widget: Widget = "text",
    **options: Any,
) -> Any:
    ui_hints: JsonDict = {"label": title, "group": group, "order": order, "widget": widget}
    return Field(
        title=title,
        description=description,
        examples=examples,
        json_schema_extra={"x-ui": ui_hints},
        **options,
    )


def section_config(title: str, description: str, extra: Literal["allow", "forbid"]) -> ConfigDict:
    return ConfigDict(
        extra=extra,
        title=title,
        json_schema_extra={"description": description},
        populate_by_name=True,
        serialize_by_alias=True,
    )


class AppSection(BaseModel):
    model_config = section_config(
        "App", "What the app is, how to start it and where its health and base paths are.", "allow"
    )

    name: str = manifest_field(
        "Name", "Display name of the app under test.", ["Gracie"], "App", 1, min_length=1
    )
    summary: str = manifest_field(
        "Summary",
        "One paragraph on what the app does and who uses it.",
        ["A voice-first assistant that answers hotel guest questions from live property data."],
        "App",
        2,
        "textarea",
    )
    kind: AppKind = manifest_field(
        "Kind",
        "Shape of the app, which selects the Tessa hints.",
        ["llm_assistant"],
        "App",
        3,
        "select",
    )
    how_to_run: str = manifest_field(
        "How to run",
        "Commands or steps that start the app locally or in QA.",
        ["docker compose up -d && npm run dev"],
        "App",
        4,
        "textarea",
    )
    health_endpoints: list[str] = manifest_field(
        "Health endpoints",
        "Method and path of each liveness or readiness endpoint.",
        [["GET /health"]],
        "App",
        5,
        "chips",
        default_factory=list,
    )
    ports: list[TcpPort] = manifest_field(
        "Ports",
        "TCP ports the app listens on.",
        [[8080, 3000]],
        "App",
        6,
        "chips",
        default_factory=list,
    )
    base_paths: list[str] = manifest_field(
        "Base paths",
        "URL path prefixes the app serves.",
        [["/api/v1"]],
        "App",
        7,
        "chips",
        default_factory=list,
    )


class InterfaceAuth(BaseModel):
    model_config = section_config(
        "Interface auth", "How a client authenticates to one interface.", "allow"
    )

    type: str = manifest_field(
        "Type",
        "Authentication scheme such as none, bearer, api_key, basic, cookie, oauth2 or "
        "hmac_sha256 (signed webhook sends: header carries the signature and secret_env names "
        "the signing secret).",
        ["bearer", "hmac_sha256"],
        "Interfaces",
        1,
        "select",
        min_length=1,
    )
    header: str | None = manifest_field(
        "Header",
        "Header that carries the credential, or the signature for hmac_sha256.",
        ["Authorization", "X-Signature-256"],
        "Interfaces",
        2,
        default=None,
    )
    token_source: dict[str, str] = manifest_field(
        "Token source",
        "How a token is obtained, keyed by role id.",
        [{"admin": "POST /auth/login with ${ADMIN_EMAIL} and ${ADMIN_PASSWORD}"}],
        "Interfaces",
        3,
        "yaml",
        default_factory=dict,
    )
    secret_env: str | None = manifest_field(
        "Signing secret variable",
        "Environment variable that holds the HMAC signing secret; required when type is "
        "hmac_sha256 and ignored by every other scheme.",
        ["WEBHOOK_SIGNING_SECRET"],
        "Interfaces",
        4,
        default=None,
        pattern=ENV_NAME_PATTERN,
    )

    @model_validator(mode="after")
    def signed_sends_need_a_secret(self) -> Self:
        if self.type.strip().lower() == HMAC_SHA256_AUTH_TYPE and self.secret_env is None:
            raise to_validation_error(
                "InterfaceAuth",
                [
                    ManifestProblem(
                        code="secret_env_required",
                        message=f"Auth type {HMAC_SHA256_AUTH_TYPE} needs secret_env, the "
                        "variable that holds the signing secret",
                        loc=("secret_env",),
                    )
                ],
            )
        return self


class InterfaceShape(BaseModel):
    model_config = section_config(
        "Interface shape", "One request and response pair with a real example each.", "allow"
    )

    name: str = manifest_field(
        "Name", "Short name of the call.", ["send chat message"], "Interfaces", 1, min_length=1
    )
    method: str | None = manifest_field(
        "Method",
        "HTTP method, when the interface is HTTP.",
        ["POST"],
        "Interfaces",
        2,
        default=None,
    )
    path: str | None = manifest_field(
        "Path",
        "Path relative to the interface base path.",
        ["/chat"],
        "Interfaces",
        3,
        default=None,
    )
    request_schema: dict[str, Any] | None = manifest_field(
        "Request schema",
        "JSON Schema of the request body.",
        [{"type": "object", "properties": {"message": {"type": "string"}}}],
        "Interfaces",
        4,
        "yaml",
        default=None,
    )
    request_example: Any = manifest_field(
        "Request example",
        "A real request body taken from the code or logs.",
        [{"message": "Which rooms are still dirty?"}],
        "Interfaces",
        5,
        "yaml",
        default=None,
    )
    response_schema: dict[str, Any] | None = manifest_field(
        "Response schema",
        "JSON Schema of the response body.",
        [{"type": "object", "properties": {"answer": {"type": "string"}}}],
        "Interfaces",
        6,
        "yaml",
        default=None,
    )
    response_example: Any = manifest_field(
        "Response example",
        "A real response body taken from the code or logs.",
        [{"answer": "Three rooms are still dirty."}],
        "Interfaces",
        7,
        "yaml",
        default=None,
    )


class Interface(BaseModel):
    model_config = section_config("Interface", "One way a client reaches the app.", "allow")

    id: str = manifest_field(
        "Id",
        "Slug other sections use to refer to this interface.",
        ["chat_sse"],
        "Interfaces",
        1,
        pattern=SLUG_PATTERN,
    )
    kind: AdapterKind = manifest_field(
        "Kind", "Protocol Tessa speaks to this interface.", ["sse"], "Interfaces", 2, "select"
    )
    base_path: str = manifest_field(
        "Base path", "Path prefix, or URL, of the interface.", ["/api/chat"], "Interfaces", 3
    )
    auth: InterfaceAuth | None = manifest_field(
        "Auth",
        "How a client authenticates to this interface.",
        [{"type": "bearer", "header": "Authorization"}],
        "Interfaces",
        4,
        "yaml",
        default=None,
    )
    health_endpoint: str | None = manifest_field(
        "Health endpoint",
        "Path that answers 2xx while the interface is up.",
        ["/health"],
        "Interfaces",
        5,
        default=None,
    )
    shapes: list[InterfaceShape] = manifest_field(
        "Shapes",
        "Request and response shapes with one real example each.",
        [[{"name": "send chat message", "method": "POST", "path": "/chat"}]],
        "Interfaces",
        6,
        "yaml",
        default_factory=list,
    )
    stream_events: list[str] = manifest_field(
        "Stream events",
        "Names of the events a streaming interface emits.",
        [["token", "done"]],
        "Interfaces",
        7,
        "chips",
        default_factory=list,
    )
    rate_limits: str | None = manifest_field(
        "Rate limits",
        "Limits the interface enforces.",
        ["60 requests per minute per user"],
        "Interfaces",
        8,
        default=None,
    )
    idempotency: str | None = manifest_field(
        "Idempotency",
        "Idempotency rules for writes on this interface.",
        ["Idempotency-Key header on every POST"],
        "Interfaces",
        9,
        default=None,
    )


class Role(BaseModel):
    model_config = section_config(
        "Role", "A kind of user and what the app lets that user see and do.", "allow"
    )

    id: str = manifest_field(
        "Id",
        "Slug features use to refer to this role.",
        ["admin"],
        "Roles",
        1,
        pattern=SLUG_PATTERN,
    )
    level: int = manifest_field(
        "Level",
        "Privilege rank; a higher number may do everything a lower one may.",
        [2],
        "Roles",
        2,
        "number",
        ge=0,
    )
    description: str = manifest_field(
        "Description", "Who holds this role.", ["Property manager"], "Roles", 3, "textarea"
    )
    can_see: list[str] = manifest_field(
        "Can see",
        "What this role may read.",
        [["all rooms of own property"]],
        "Roles",
        4,
        "chips",
        default_factory=list,
    )
    can_do: list[str] = manifest_field(
        "Can do",
        "What this role may change.",
        [["create maintenance issues"]],
        "Roles",
        5,
        "chips",
        default_factory=list,
    )
    credential_env: str | None = manifest_field(
        "Credential variable",
        "Environment variable that holds this role's login or token.",
        ["ADMIN_TOKEN"],
        "Roles",
        6,
        default=None,
        pattern=ENV_NAME_PATTERN,
    )


class FeatureExample(BaseModel):
    model_config = section_config(
        "Feature example", "One concrete input with the behaviour expected from it.", "allow"
    )

    ask: str | None = manifest_field(
        "Ask",
        "Natural language input, for chat features.",
        ["Which maintenance issues are still open?"],
        "Features",
        1,
        default=None,
    )
    request: dict[str, Any] | None = manifest_field(
        "Request",
        "Structured request, for API features.",
        [{"path": "/rooms", "method": "GET"}],
        "Features",
        2,
        "yaml",
        default=None,
    )
    expected: str = manifest_field(
        "Expected",
        "Behaviour the app must show, in words an oracle can check.",
        ["count of open items and the rooms with the most, from the oracle"],
        "Features",
        3,
        "textarea",
        min_length=1,
    )
    oracle: str | None = manifest_field(
        "Oracle",
        "Name of the oracle that computes the expected result.",
        ["open_maintenance"],
        "Features",
        4,
        default=None,
    )


class Feature(BaseModel):
    model_config = section_config(
        "Feature", "One testable thing the app does; the catalog is built from these.", "allow"
    )

    id: str = manifest_field(
        "Id",
        "Stable id, unique per target across bundle versions.",
        ["smart_log.read.open_maintenance"],
        "Features",
        1,
        pattern=SLUG_PATTERN,
    )
    area: str = manifest_field(
        "Area",
        "Product area the feature belongs to.",
        ["Smart Log"],
        "Features",
        2,
        min_length=1,
    )
    kind: FeatureKind = manifest_field(
        "Kind", "What sort of behaviour this is.", ["read"], "Features", 3, "select"
    )
    description: str = manifest_field(
        "Description",
        "What the feature does, in one or two sentences.",
        ["List maintenance issues that are still open, optionally per room"],
        "Features",
        4,
        "textarea",
        min_length=1,
    )
    interfaces: list[str] = manifest_field(
        "Interfaces",
        "Ids of the interfaces that expose the feature.",
        [["chat_sse", "browser"]],
        "Features",
        5,
        "chips",
        default_factory=list,
    )
    roles: list[str] = manifest_field(
        "Roles",
        "Ids of the roles that may use the feature, or all.",
        [["all"]],
        "Features",
        6,
        "chips",
        default_factory=list,
    )
    flag: str = manifest_field(
        "Flag",
        "Feature flag that gates the feature, or none.",
        ["none"],
        "Features",
        7,
        default="none",
    )
    preconditions: list[str] = manifest_field(
        "Preconditions",
        "Seed fixtures or states that must hold first.",
        [["seed.smart_log_history"]],
        "Features",
        8,
        "chips",
        default_factory=list,
    )
    examples: list[FeatureExample] = manifest_field(
        "Examples",
        "Concrete inputs with the expected behaviour.",
        [[{"ask": "Which maintenance issues are still open?", "expected": "count of open items"}]],
        "Features",
        9,
        "yaml",
        default_factory=list,
    )
    invariants: list[str] = manifest_field(
        "Invariants",
        "Ids of the invariants that apply to the feature.",
        [["no_internal_ids", "count_matches_oracle"]],
        "Features",
        10,
        "chips",
        default_factory=list,
    )
    cleanup: str = manifest_field(
        "Cleanup",
        "How to undo a write the feature makes, or none.",
        ["none"],
        "Features",
        11,
        default="none",
    )
    confidence: Confidence = manifest_field(
        "Confidence",
        "How sure the author is that this entry matches the code.",
        ["high"],
        "Features",
        12,
        "select",
        default=Confidence.medium,
    )
    writes_to: str | None = manifest_field(
        "Writes to",
        "Entity a write feature changes.",
        ["maintenance_issue"],
        "Features",
        13,
        default=None,
    )
    confirmation: str | None = manifest_field(
        "Confirmation",
        "How a write is confirmed before it takes effect.",
        ["button-only, typed yes accepted"],
        "Features",
        14,
        default=None,
    )
    expect_db: dict[str, Any] | None = manifest_field(
        "Expected database change",
        "The row or change a write must leave behind.",
        [{"table": "maintenance_issue", "where": {"status": "open"}}],
        "Features",
        15,
        "yaml",
        default=None,
    )


class Entity(BaseModel):
    model_config = section_config("Entity", "A table or collection of one store.", "allow")

    name: str = manifest_field(
        "Name", "Table or collection name.", ["maintenance_issue"], "Data", 1, min_length=1
    )
    key_fields: list[str] = manifest_field(
        "Key fields",
        "Fields that identify or define the entity.",
        [["id", "room_id"]],
        "Data",
        2,
        "chips",
        default_factory=list,
    )
    tenant_field: str | None = manifest_field(
        "Tenant field",
        "Field that scopes a row to a tenant.",
        ["property_id"],
        "Data",
        3,
        default=None,
    )
    status_fields: list[str] = manifest_field(
        "Status fields",
        "Fields that hold a lifecycle status.",
        [["status"]],
        "Data",
        4,
        "chips",
        default_factory=list,
    )
    soft_delete: str | None = manifest_field(
        "Soft delete",
        "How deleted rows are marked, if they are kept.",
        ["deleted_at is not null"],
        "Data",
        5,
        default=None,
    )


class DataStore(BaseModel):
    model_config = section_config("Data store", "A database or other store the app uses.", "allow")

    name: str = manifest_field("Name", "Name of the store.", ["primary"], "Data", 1, min_length=1)
    kind: str = manifest_field(
        "Kind",
        "Engine of the store such as postgres, mysql, mongodb or redis.",
        ["postgres"],
        "Data",
        2,
        "select",
        min_length=1,
    )
    entities: list[Entity] = manifest_field(
        "Entities",
        "Tables or collections that matter for testing.",
        [[{"name": "maintenance_issue", "tenant_field": "property_id"}]],
        "Data",
        3,
        "yaml",
        default_factory=list,
    )


class DataModel(BaseModel):
    model_config = section_config(
        "Data model", "Where the app keeps its data and how rows are scoped.", "allow"
    )

    stores: list[DataStore] = manifest_field(
        "Stores",
        "Databases or other stores the app uses.",
        [[{"name": "primary", "kind": "postgres"}]],
        "Data",
        1,
        "yaml",
        default_factory=list,
    )
    timezone: str | None = manifest_field(
        "Timezone",
        "How the app handles time zones.",
        ["UTC in storage, property local time in UI"],
        "Data",
        2,
        default=None,
    )


class TruthSource(BaseModel):
    model_config = section_config(
        "Truth source",
        "A database or read endpoint an expected result can be computed from.",
        "allow",
    )

    id: str = manifest_field(
        "Id",
        "Slug oracles use to refer to this source.",
        ["primary_db"],
        "Truth",
        1,
        pattern=SLUG_PATTERN,
    )
    kind: Literal["database", "read_endpoint"] = manifest_field(
        "Kind",
        "Whether the source is a database or an HTTP read endpoint.",
        ["database"],
        "Truth",
        2,
        "select",
    )
    description: str = manifest_field(
        "Description",
        "What the source holds.",
        ["Smart Log tables, read-only replica"],
        "Truth",
        3,
        "textarea",
        default="",
    )
    connection_env: str = manifest_field(
        "Connection variable",
        "Environment variable that holds the READ-ONLY connection.",
        ["TRUTH_DB_DSN"],
        "Truth",
        4,
        pattern=ENV_NAME_PATTERN,
    )
    dialect: str | None = manifest_field(
        "Dialect",
        "SQL dialect of a database source, lower case, for example postgres; required for "
        "databases because oracle queries are parsed in that dialect.",
        ["postgres"],
        "Truth",
        5,
        default=None,
        pattern=DIALECT_PATTERN,
    )

    @model_validator(mode="after")
    def database_sources_declare_a_dialect(self) -> Self:
        if self.kind == "database" and self.dialect is None:
            raise to_validation_error(
                "TruthSource",
                [
                    ManifestProblem(
                        code="dialect_required",
                        message="A database truth source must declare its SQL dialect",
                        loc=("dialect",),
                    )
                ],
            )
        return self


class Seeds(BaseModel):
    model_config = section_config(
        "Seeds", "How a QA tenant is made to look the same on every run.", "allow"
    )

    description: str | None = manifest_field(
        "Description",
        "How the seeded state is built.",
        ["Fixtures loaded by seeds/reset.sql"],
        "Seeds",
        1,
        "textarea",
        default=None,
    )
    fixtures: list[FixturePath] = manifest_field(
        "Fixtures",
        "Paths of fixture files, relative to the bundle folder, starting with seeds/.",
        [["seeds/fixtures.sql"]],
        "Seeds",
        2,
        "chips",
        default_factory=list,
    )
    reset_script: str | None = manifest_field(
        "Reset script",
        "Path of the script that restores the seeded state: seeds/ plus a .sql, .py or .sh file.",
        ["seeds/reset.sql"],
        "Seeds",
        3,
        default=None,
        pattern=SEED_SCRIPT_PATTERN,
    )
    hash_command: str | None = manifest_field(
        "Hash command",
        "One command line, run from a copy of the bundle folder so that paths such as "
        "seeds/hash.sh resolve, that exits 0 and prints the hash of the seeded state as the "
        "last line of its output (8 to 128 characters of letters, digits, colon, underscore or "
        "hyphen). It must only read. Secrets appear as ${NAME} placeholders.",
        ["bash seeds/hash.sh"],
        "Seeds",
        4,
        default=None,
        min_length=1,
    )
    expected_hash: str | None = manifest_field(
        "Expected hash",
        "Hash the seeded state must produce; absent means the first reset records it.",
        ["9f2c1d8e7b6a5d4c"],
        "Seeds",
        5,
        default=None,
        pattern=SEED_HASH_PATTERN,
    )
    dsn_env: str | None = manifest_field(
        "Seed connection variable",
        "Environment variable of the write-capable connection a .sql reset script runs on. It "
        "must differ from every truth source connection variable.",
        ["SEED_DB_DSN"],
        "Seeds",
        6,
        default=None,
        pattern=ENV_NAME_PATTERN,
    )

    @model_validator(mode="after")
    def sql_reset_scripts_need_a_connection(self) -> Self:
        if (
            self.reset_script is not None
            and self.reset_script.endswith(".sql")
            and self.dsn_env is None
        ):
            raise to_validation_error(
                "Seeds",
                [
                    ManifestProblem(
                        code="seed_dsn_required",
                        message="A .sql reset script needs dsn_env, the variable of the "
                        "connection it runs on",
                        loc=("dsn_env",),
                    )
                ],
            )
        return self


class Invariant(BaseModel):
    model_config = section_config("Invariant", "A rule that must always hold.", "allow")

    id: str = manifest_field(
        "Id",
        "Slug features use to refer to this invariant.",
        ["no_internal_ids"],
        "Invariants",
        1,
        pattern=SLUG_PATTERN,
    )
    rule: str = manifest_field(
        "Rule",
        "The rule in one sentence.",
        ["Responses never contain internal database ids"],
        "Invariants",
        2,
        "textarea",
        min_length=1,
    )
    check: Literal["code", "probe", "oracle", "db"] = manifest_field(
        "Check", "How the rule can be checked.", ["code"], "Invariants", 3, "select"
    )


class Flag(BaseModel):
    model_config = section_config("Flag", "A feature flag that changes app behaviour.", "allow")

    id: str = manifest_field(
        "Id",
        "Slug features use in their flag field.",
        ["new_checkout"],
        "Flags",
        1,
        pattern=SLUG_PATTERN,
    )
    env_var: str | None = manifest_field(
        "Variable",
        "Environment variable that sets the flag.",
        ["FEATURE_NEW_CHECKOUT"],
        "Flags",
        2,
        default=None,
    )
    description: str = manifest_field(
        "Description",
        "What the flag changes.",
        ["Switches to the single page checkout"],
        "Flags",
        3,
        "textarea",
        default="",
    )
    affects: list[str] = manifest_field(
        "Affects",
        "Ids of the features the flag changes.",
        [["shop.write.checkout"]],
        "Flags",
        4,
        "chips",
        default_factory=list,
    )


class EnvironmentVariable(BaseModel):
    model_config = section_config(
        "Environment variable", "A value Tessa needs to reach or inspect the app.", "allow"
    )

    name: str = manifest_field(
        "Name",
        "Variable name; placeholders in the bundle use ${NAME}.",
        ["GRACIE_BASE_URL"],
        "Environment",
        1,
        pattern=ENV_NAME_PATTERN,
    )
    kind: EnvVarKind = manifest_field(
        "Kind",
        "What the value is.",
        ["url"],
        "Environment",
        2,
        "select",
        default=EnvVarKind.string,
    )
    secret: bool = manifest_field(
        "Secret",
        "Whether the value is a secret; secrets are never shown again.",
        [False],
        "Environment",
        3,
        "toggle",
        default=True,
    )
    required: bool = manifest_field(
        "Required",
        "Whether Tessa cannot run without the value.",
        [True],
        "Environment",
        4,
        "toggle",
        default=True,
    )
    purpose: str = manifest_field(
        "Purpose",
        "One line on what the value is used for.",
        ["Base URL of the QA deployment"],
        "Environment",
        5,
        default="",
    )
    interfaces: list[str] = manifest_field(
        "Interfaces",
        "Ids of the interfaces the value belongs to.",
        [["chat_sse"]],
        "Environment",
        6,
        "chips",
        default_factory=list,
    )

    @model_validator(mode="after")
    def credentials_are_always_secret(self) -> Self:
        if self.kind in ALWAYS_SECRET_KINDS and not self.secret:
            raise to_validation_error(
                "EnvironmentVariable",
                [
                    ManifestProblem(
                        code="secret_required_for_kind",
                        message=f"A variable of kind {self.kind.value} is always secret; "
                        "set secret: true",
                        loc=("secret",),
                        value=self.secret,
                    )
                ],
            )
        return self


class QaHook(BaseModel):
    model_config = section_config(
        "Test hook", "A QA-only hook of the app, present or missing.", "allow"
    )

    id: str = manifest_field(
        "Id", "Slug of the hook.", ["pin_clock"], "Hooks", 1, pattern=SLUG_PATTERN
    )
    description: str = manifest_field(
        "Description",
        "What the hook does or would do.",
        ["Pins the server clock to a given time"],
        "Hooks",
        2,
        "textarea",
        min_length=1,
    )
    endpoint: str | None = manifest_field(
        "Endpoint",
        "Method and path of an existing hook.",
        ["POST /qa/clock"],
        "Hooks",
        3,
        default=None,
    )


class QaHooks(BaseModel):
    model_config = section_config(
        "Test hooks", "Which QA hooks the app has and which it lacks.", "allow"
    )

    available: list[QaHook] = manifest_field(
        "Available",
        "Hooks that exist today.",
        [[{"id": "health", "description": "Health probe"}]],
        "Hooks",
        1,
        "yaml",
        default_factory=list,
    )
    missing: list[QaHook] = manifest_field(
        "Missing",
        "Hooks the app lacks; a separate prompt asks for them.",
        [[{"id": "pin_clock", "description": "Pin the server clock"}]],
        "Hooks",
        2,
        "yaml",
        default_factory=list,
    )


class CleanupSection(BaseModel):
    model_config = section_config(
        "Cleanup", "What a test run leaves behind and what it costs.", "allow"
    )

    irreversible: list[str] = manifest_field(
        "Irreversible",
        "Actions that cannot be undone.",
        [["sent notification emails"]],
        "Notes",
        1,
        "chips",
        default_factory=list,
    )
    delete_after_run: list[str] = manifest_field(
        "Delete after run",
        "Things to remove after a run.",
        [["issues created by the suite"]],
        "Notes",
        2,
        "chips",
        default_factory=list,
    )
    costs_money: list[str] = manifest_field(
        "Costs money",
        "Actions that incur charges.",
        [["SMS sends"]],
        "Notes",
        3,
        "chips",
        default_factory=list,
    )


class ConsumedCall(BaseModel):
    model_config = section_config(
        "Consumed call",
        "A call this app sends to another app: the request shape it sends and the response "
        "fields it reads. The contract check compares it with the interfaces of the provider "
        "bundle.",
        "allow",
    )

    id: str = manifest_field(
        "Id",
        "Slug of the call, unique within consumes.",
        ["calendar_event_push"],
        "Consumes",
        1,
        pattern=SLUG_PATTERN,
    )
    provider_hint: str | None = manifest_field(
        "Provider hint",
        "Name or slug of the app that receives the call, when the code says so.",
        ["hotel-ops"],
        "Consumes",
        2,
        default=None,
    )
    method: str = manifest_field(
        "Method", "HTTP method of the call.", ["POST"], "Consumes", 3, min_length=1
    )
    path: str = manifest_field(
        "Path",
        "Path the call is sent to, below the provider interface base path; {name} segments stand "
        "for path parameters.",
        ["/calendar/events"],
        "Consumes",
        4,
        min_length=1,
    )
    auth_scheme: str | None = manifest_field(
        "Auth scheme",
        "Authentication scheme the call presents, such as bearer or api_key.",
        ["bearer"],
        "Consumes",
        5,
        default=None,
    )
    request: dict[str, Any] = manifest_field(
        "Request",
        "Shape of what the call sends: a JSON Schema of the request body, or a real example body.",
        [{"type": "object", "required": ["title", "starts_at"]}],
        "Consumes",
        6,
        "yaml",
    )
    reads: list[str] = manifest_field(
        "Reads",
        "Fields of the response this app reads, as dotted paths from the response body root.",
        [["data.id", "data.status"]],
        "Consumes",
        7,
        "chips",
    )


class SourceSection(BaseModel):
    model_config = section_config(
        "Source",
        "The commit of the repository the bundle was produced from, so a failure can be tied to "
        "the code that was read.",
        "allow",
    )

    commit: str = manifest_field(
        "Commit",
        "Commit the bundle describes, as 7 to 40 lowercase hex digits (git rev-parse HEAD).",
        ["3f9c2ab41d7e"],
        "Identity",
        1,
        pattern=COMMIT_PATTERN,
    )
    branch: str | None = manifest_field(
        "Branch",
        "Branch that was checked out.",
        ["main"],
        "Identity",
        2,
        default=None,
        max_length=200,
    )
    dirty: bool = manifest_field(
        "Dirty",
        "True when the working tree had changes that were not committed.",
        [False],
        "Identity",
        3,
        "toggle",
        default=False,
    )


class BundleManifest(BaseModel):
    model_config = section_config(
        "Tessa bundle manifest",
        "The machine-readable manifest.yaml of a Tessa bundle: everything Tessa needs to "
        "test a running app from outside. Placeholders ${NAME} stand in for every secret. "
        "Unknown top-level keys are errors; unknown keys inside a section are kept. This schema "
        "checks shape only: Tessa also checks on upload that every reference resolves "
        "(feature interfaces, roles and flags, truth source and seed variables, ids unique) and "
        "that every ${NAME} placeholder is declared in environment. The same bundle carries "
        "oracle/<name>.yaml (OracleSidecar), flows/<id>.yaml (Flow) and env.template "
        "(EnvTemplate), and may carry the optional file mutants.yaml (MutantsSidecar, a list of "
        "MutantFields entries written in the Mutants round-trip); their formats are defined "
        "under $defs.",
        "forbid",
    )

    schema_url: str = manifest_field(
        "Schema",
        "URL of this schema; Tessa fills it into the Discovery prompt.",
        ["http://localhost:8000/schemas/bundle.v1.json"],
        "Identity",
        1,
        alias="schema",
        pattern=SCHEMA_URL_PATTERN,
    )
    target_token: str = manifest_field(
        "Target token",
        "Routing token that matches an upload to its target.",
        ["tgt_abcdefghijklmnopqrstuv"],
        "Identity",
        2,
        pattern=TARGET_TOKEN_PATTERN,
    )
    app: AppSection = manifest_field(
        "App",
        "What the app is and how to run it.",
        [
            {
                "name": "Gracie",
                "summary": "Hotel assistant",
                "kind": "llm_assistant",
                "how_to_run": "npm run dev",
            }
        ],
        "App",
        3,
        "yaml",
    )
    interfaces: list[Interface] = manifest_field(
        "Interfaces",
        "Every way a client reaches the app.",
        [[{"id": "chat_sse", "kind": "sse", "base_path": "/api/chat"}]],
        "Interfaces",
        4,
        "yaml",
        min_length=1,
    )
    roles: list[Role] = manifest_field(
        "Roles",
        "Every kind of user and what each may see and do; an app without login declares one "
        "role such as anonymous.",
        [[{"id": "admin", "level": 2, "description": "Property manager"}]],
        "Roles",
        5,
        "yaml",
        min_length=1,
    )
    features: list[Feature] = manifest_field(
        "Features",
        "The catalog of testable things.",
        [
            [
                {
                    "id": "smart_log.read.open_maintenance",
                    "area": "Smart Log",
                    "kind": "read",
                    "description": "List open maintenance issues",
                }
            ]
        ],
        "Features",
        6,
        "yaml",
        min_length=1,
    )
    data_model: DataModel | None = manifest_field(
        "Data model",
        "Stores, tables and how rows are scoped.",
        [{"stores": [{"name": "primary", "kind": "postgres"}]}],
        "Data",
        7,
        "yaml",
        default=None,
    )
    truth_sources: list[TruthSource] = manifest_field(
        "Truth sources",
        "Databases and read endpoints an expected result can be computed from.",
        [[{"id": "primary_db", "kind": "database", "connection_env": "TRUTH_DB_DSN"}]],
        "Truth",
        8,
        "yaml",
        default_factory=list,
    )
    seeds: Seeds | None = manifest_field(
        "Seeds",
        "How a QA tenant is made identical on every run.",
        [{"reset_script": "seeds/reset.sql", "hash_command": "psql -At -f seeds/hash.sql"}],
        "Seeds",
        9,
        "yaml",
        default=None,
    )
    invariants: list[Invariant] = manifest_field(
        "Invariants",
        "Rules that must always hold and how each is checked.",
        [[{"id": "no_internal_ids", "rule": "No internal ids in responses", "check": "code"}]],
        "Invariants",
        10,
        "yaml",
        default_factory=list,
    )
    flags: list[Flag] = manifest_field(
        "Flags",
        "Feature flags that change behaviour.",
        [[{"id": "new_checkout", "env_var": "FEATURE_NEW_CHECKOUT"}]],
        "Flags",
        11,
        "yaml",
        default_factory=list,
    )
    environment: list[EnvironmentVariable] = manifest_field(
        "Environment",
        "Every variable Tessa needs, with placeholders instead of values.",
        [[{"name": "GRACIE_BASE_URL", "kind": "url", "secret": False}]],
        "Environment",
        12,
        "yaml",
        min_length=1,
    )
    test_hooks: QaHooks | None = manifest_field(
        "Test hooks",
        "Which QA hooks exist and which are missing.",
        [{"missing": [{"id": "pin_clock", "description": "Pin the server clock"}]}],
        "Hooks",
        13,
        "yaml",
        default=None,
    )
    limitations: list[str] = manifest_field(
        "Limitations",
        "What cannot be tested or undone.",
        [["no sandbox for payments"]],
        "Notes",
        14,
        "chips",
        default_factory=list,
    )
    cleanup: CleanupSection | None = manifest_field(
        "Cleanup",
        "What a run leaves behind and what it costs.",
        [{"delete_after_run": ["issues created by the suite"]}],
        "Notes",
        15,
        "yaml",
        default=None,
    )
    consumes: list[ConsumedCall] = manifest_field(
        "Consumes",
        "Calls this app sends to other apps, with the request shape sent and the response "
        "fields read; the input of the contract check.",
        [
            [
                {
                    "id": "calendar_event_push",
                    "method": "POST",
                    "path": "/calendar/events",
                    "request": {"type": "object", "required": ["title", "starts_at"]},
                    "reads": ["data.id", "data.status"],
                }
            ]
        ],
        "Consumes",
        16,
        "yaml",
        default_factory=list,
    )
    source: SourceSection | None = manifest_field(
        "Source",
        "Commit and branch of the repository the bundle was produced from.",
        [{"commit": "3f9c2ab41d7e", "branch": "main", "dirty": False}],
        "Identity",
        17,
        "yaml",
        default=None,
    )

    @model_validator(mode="after")
    def references_resolve(self, info: ValidationInfo) -> Self:
        context = info.context
        if isinstance(context, dict) and context.get(SKIP_REFERENCE_CHECKS):
            return self
        problems = find_reference_problems(self)
        if problems:
            raise to_validation_error("BundleManifest", problems)
        return self
