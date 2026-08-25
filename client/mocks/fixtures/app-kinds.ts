import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export interface AppKindHintDefinition {
  id: string;
  label: string;
  default_on: boolean;
  instruction: string;
}

export interface AppKindDefinition {
  kind: Schemas["AppKind"];
  label: string;
  hints: readonly AppKindHintDefinition[];
}

export const APP_KIND_DEFINITIONS: readonly AppKindDefinition[] = [
  {
    kind: "web",
    label: "Web app",
    hints: [
      {
        id: "browser_flows",
        label: "Describe the key browser flows",
        default_on: true,
        instruction:
          "Describe the key user journeys as flows/*.yaml with ordered steps: url, action, target by accessibility role and name, and the expected state.",
      },
      {
        id: "login_methods",
        label: "List how each role signs in",
        default_on: true,
        instruction:
          "For each role, say how it signs in (form, SSO, magic link, token) and which environment variable holds its credential.",
      },
    ],
  },
  {
    kind: "api",
    label: "HTTP API",
    hints: [
      {
        id: "openapi_schema",
        label: "Include the OpenAPI schema",
        default_on: true,
        instruction:
          "Include openapi.json, or a link to it, and one real request and response example per endpoint.",
      },
      {
        id: "rate_limits_and_idempotency",
        label: "Record rate limits and idempotency rules",
        default_on: false,
        instruction:
          "Record rate limits, pagination rules and idempotency rules for every interface.",
      },
    ],
  },
  {
    kind: "llm_assistant",
    label: "LLM assistant",
    hints: [
      {
        id: "list_tools",
        label: "List the tools the assistant can call",
        default_on: true,
        instruction:
          "List every tool the assistant can call, with its arguments, what it reads or writes, and which roles may trigger it.",
      },
      {
        id: "confirmation_gate",
        label: "Describe the confirmation gate for writes",
        default_on: true,
        instruction:
          "Describe the confirmation gate: which writes need confirmation, how it is given (button only, typed yes accepted) and what the assistant may claim before it.",
      },
      {
        id: "transcript_trace_endpoints",
        label: "Find the transcript and trace endpoints",
        default_on: true,
        instruction:
          "Name the endpoints or tables that expose a conversation transcript and a per-turn trace of the tools that ran.",
      },
    ],
  },
  {
    kind: "worker",
    label: "Background worker",
    hints: [
      {
        id: "queues_and_jobs",
        label: "List queues, jobs and schedules",
        default_on: true,
        instruction:
          "List every queue, job type and schedule, how a job is enqueued from outside and where its result can be observed.",
      },
    ],
  },
  {
    kind: "cli",
    label: "Command line tool",
    hints: [
      {
        id: "commands_and_exit_codes",
        label: "List commands, flags and exit codes",
        default_on: true,
        instruction:
          "List every command with its flags, a real invocation and the expected output and exit code.",
      },
    ],
  },
];

export function appKindDefinition(kind: Schemas["AppKind"]): AppKindDefinition {
  const definition = APP_KIND_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (definition === undefined) {
    throw new Error(`unknown app kind ${kind}`);
  }
  return definition;
}

export function knownHintIds(kind: Schemas["AppKind"]): string[] {
  return appKindDefinition(kind).hints.map((hint) => hint.id);
}

export function hintInstructions(kind: Schemas["AppKind"], hintIds: readonly string[]): string[] {
  return appKindDefinition(kind)
    .hints.filter((hint) => hintIds.includes(hint.id))
    .map((hint) => hint.instruction);
}

export function toAppKindList(): Schemas["AppKindList"] {
  return {
    items: APP_KIND_DEFINITIONS.map((definition) => ({
      kind: definition.kind,
      label: definition.label,
      hints: definition.hints.map(({ id, label, default_on }) => ({ id, label, default_on })),
    })),
  };
}
