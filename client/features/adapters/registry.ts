import {
  AppWindow,
  Braces,
  Cable,
  CircleHelp,
  Globe,
  Radio,
  Terminal,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { AdapterKind } from "@/lib/api/types";

export type PayloadKind = AdapterKind | "pipeline";

export interface AdapterEntry {
  kind: string;
  label: string;
  icon: LucideIcon;
  summary: string;
  envHint: string;
}

const ADAPTER_ENTRIES: Readonly<Record<PayloadKind, AdapterEntry>> = {
  http: {
    kind: "http",
    label: "HTTP",
    icon: Globe,
    summary: "Calls a REST API with plain requests and checks the responses.",
    envHint: "Holds the address or credentials of the REST API this interface calls.",
  },
  sse: {
    kind: "sse",
    label: "Chat stream",
    icon: Radio,
    summary: "Opens a server-sent event stream, such as a chat reply, and reads it until it ends.",
    envHint: "Holds the address or credentials used to open the event stream.",
  },
  websocket: {
    kind: "websocket",
    label: "WebSocket",
    icon: Cable,
    summary: "Opens a WebSocket, sends scripted messages and records what comes back.",
    envHint: "Holds the ws or wss address or the token the handshake needs.",
  },
  graphql: {
    kind: "graphql",
    label: "GraphQL",
    icon: Braces,
    summary: "Sends GraphQL operations to one endpoint and checks data and errors.",
    envHint: "Holds the GraphQL endpoint address or the token sent with each operation.",
  },
  browser: {
    kind: "browser",
    label: "Browser",
    icon: AppWindow,
    summary: "Drives a real browser the way a person would and reads the page.",
    envHint: "Holds sign-in details or addresses that are typed into the page.",
  },
  webhook: {
    kind: "webhook",
    label: "Webhook",
    icon: Webhook,
    summary:
      "Sends a signed webhook to the app and records what the app calls back on a receiver Tessa runs for the run.",
    envHint:
      "Holds the signing secret or the address of the hook. The app must be able to reach the receiver, and the health check says when it cannot.",
  },
  cli: {
    kind: "cli",
    label: "Command line",
    icon: Terminal,
    summary: "Runs an allow-listed command and records its exit code and output.",
    envHint:
      "Holds values passed to the command. Steps record only the variable names, never the values, and only allow-listed commands run.",
  },
  pipeline: {
    kind: "pipeline",
    label: "Data pipeline",
    icon: Workflow,
    summary: "Ingests a fixture, then checks the index state and what each role can see.",
    envHint: "Holds the addresses or credentials the pipeline checks use.",
  },
};

const ENTRIES_BY_KIND: ReadonlyMap<string, AdapterEntry> = new Map(
  Object.entries(ADAPTER_ENTRIES),
);

export const ADAPTER_KINDS: readonly AdapterKind[] = [
  "http",
  "sse",
  "websocket",
  "graphql",
  "browser",
  "webhook",
  "cli",
];

export function isKnownAdapterKind(kind: string): kind is PayloadKind {
  return ENTRIES_BY_KIND.has(kind);
}

export function describeAdapterKind(kind: string): AdapterEntry {
  return (
    ENTRIES_BY_KIND.get(kind) ?? {
      kind,
      label: kind,
      icon: CircleHelp,
      summary: "This kind has no dedicated description yet.",
      envHint: `Used by an interface of kind ${kind}.`,
    }
  );
}

export function describeAdapterLabel(kind: string): string {
  return describeAdapterKind(kind).label;
}

export function payloadKindOf(payload: unknown): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    typeof payload.kind === "string"
  ) {
    return payload.kind;
  }
  return null;
}

export function distinctAdapterKinds(
  interfaceIds: readonly string[],
  kindsById: ReadonlyMap<string, AdapterKind> | undefined,
): AdapterKind[] {
  if (kindsById === undefined) {
    return [];
  }
  const kinds = new Set<AdapterKind>();
  for (const interfaceId of interfaceIds) {
    const kind = kindsById.get(interfaceId);
    if (kind !== undefined) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}
