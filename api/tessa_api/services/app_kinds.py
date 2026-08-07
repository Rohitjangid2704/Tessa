from collections.abc import Sequence
from dataclasses import dataclass

from tessa_api.schemas.enums import AppKind
from tessa_api.schemas.targets import AppKindHint, AppKindList, AppKindOption


@dataclass(frozen=True)
class HintDefinition:
    id: str
    label: str
    default_on: bool
    instruction: str


@dataclass(frozen=True)
class AppKindDefinition:
    kind: AppKind
    label: str
    hints: tuple[HintDefinition, ...]


APP_KIND_REGISTRY: tuple[AppKindDefinition, ...] = (
    AppKindDefinition(
        kind=AppKind.web,
        label="Web app",
        hints=(
            HintDefinition(
                id="browser_flows",
                label="Describe the key browser flows",
                default_on=True,
                instruction=(
                    "Describe the key user journeys as flows/*.yaml with ordered steps: url, "
                    "action, target by accessibility role and name, and the expected state."
                ),
            ),
            HintDefinition(
                id="login_methods",
                label="List how each role signs in",
                default_on=True,
                instruction=(
                    "For each role, say how it signs in (form, SSO, magic link, token) and which "
                    "environment variable holds its credential."
                ),
            ),
        ),
    ),
    AppKindDefinition(
        kind=AppKind.api,
        label="HTTP API",
        hints=(
            HintDefinition(
                id="openapi_schema",
                label="Include the OpenAPI schema",
                default_on=True,
                instruction=(
                    "Include openapi.json, or a link to it, and one real request and response "
                    "example per endpoint."
                ),
            ),
            HintDefinition(
                id="rate_limits_and_idempotency",
                label="Record rate limits and idempotency rules",
                default_on=False,
                instruction=(
                    "Record rate limits, pagination rules and idempotency rules for every "
                    "interface."
                ),
            ),
        ),
    ),
    AppKindDefinition(
        kind=AppKind.llm_assistant,
        label="LLM assistant",
        hints=(
            HintDefinition(
                id="list_tools",
                label="List the tools the assistant can call",
                default_on=True,
                instruction=(
                    "List every tool the assistant can call, with its arguments, what it reads "
                    "or writes, and which roles may trigger it."
                ),
            ),
            HintDefinition(
                id="confirmation_gate",
                label="Describe the confirmation gate for writes",
                default_on=True,
                instruction=(
                    "Describe the confirmation gate: which writes need confirmation, how it is "
                    "given (button only, typed yes accepted) and what the assistant may claim "
                    "before it."
                ),
            ),
            HintDefinition(
                id="transcript_trace_endpoints",
                label="Find the transcript and trace endpoints",
                default_on=True,
                instruction=(
                    "Name the endpoints or tables that expose a conversation transcript and a "
                    "per-turn trace of the tools that ran."
                ),
            ),
        ),
    ),
    AppKindDefinition(
        kind=AppKind.worker,
        label="Background worker",
        hints=(
            HintDefinition(
                id="queues_and_jobs",
                label="List queues, jobs and schedules",
                default_on=True,
                instruction=(
                    "List every queue, job type and schedule, how a job is enqueued from outside "
                    "and where its result can be observed."
                ),
            ),
        ),
    ),
    AppKindDefinition(
        kind=AppKind.cli,
        label="Command line tool",
        hints=(
            HintDefinition(
                id="commands_and_exit_codes",
                label="List commands, flags and exit codes",
                default_on=True,
                instruction=(
                    "List every command with its flags, a real invocation and the expected "
                    "output and exit code."
                ),
            ),
        ),
    ),
)

_DEFINITIONS = {definition.kind: definition for definition in APP_KIND_REGISTRY}


def app_kind_definition(kind: AppKind) -> AppKindDefinition:
    return _DEFINITIONS[kind]


def known_hint_ids(kind: AppKind) -> list[str]:
    return [hint.id for hint in _DEFINITIONS[kind].hints]


def default_hint_ids(kind: AppKind) -> list[str]:
    return [hint.id for hint in _DEFINITIONS[kind].hints if hint.default_on]


def hint_instructions(kind: AppKind, hint_ids: Sequence[str]) -> list[str]:
    selected = set(hint_ids)
    return [hint.instruction for hint in _DEFINITIONS[kind].hints if hint.id in selected]


def list_app_kinds() -> AppKindList:
    return AppKindList(
        items=[
            AppKindOption(
                kind=definition.kind,
                label=definition.label,
                hints=[
                    AppKindHint(id=hint.id, label=hint.label, default_on=hint.default_on)
                    for hint in definition.hints
                ],
            )
            for definition in APP_KIND_REGISTRY
        ]
    )
