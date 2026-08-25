import { renderScenarioYaml } from "../stage2/scenario-factory";
import type { MockState } from "../state";
import type { Scenario, ScenarioStatus } from "@/lib/api/types";

const REPLAY_FEATURE_ID = "streaming.stream.chat_reply";
const REPLAY_FAMILY = "streaming-jobs";
const REPLAY_ROLE = "guest";
const REPLAY_INTERFACE = "chat_sse";
const REPLAY_TIMEOUT_SECONDS = 120;
const ASK_MAX = 120;

export interface ReplayScenarioInput {
  scenarioId: string;
  targetId: string;
  bundleId: string;
  bundleVersion: number;
  replayId: string;
  excerpt: string;
  status: ScenarioStatus;
  createdAt: string;
}

export function askFromExcerpt(excerpt: string): string {
  const firstTurn = excerpt.split("[assistant]")[0] ?? excerpt;
  const text = firstTurn.replace("[user]", "").trim();
  return (text === "" ? "Hello, I need some help with my stay." : text).slice(0, ASK_MAX);
}

export function buildReplayScenario(input: ReplayScenarioInput): Scenario {
  const ask = askFromExcerpt(input.excerpt);
  const title = `Replayed: ${ask}`;
  const doc = {
    schema_version: 1,
    title,
    feature_id: REPLAY_FEATURE_ID,
    family: REPLAY_FAMILY,
    role: REPLAY_ROLE,
    interface_id: REPLAY_INTERFACE,
    timeout_seconds: REPLAY_TIMEOUT_SECONDS,
    cell: { role: REPLAY_ROLE, interface_id: REPLAY_INTERFACE },
    synthetic: false,
    steps: [
      {
        label: "Ask what the guest asked",
        adapter: "sse",
        ask,
        request: { method: "POST", path: "/api/v1/chat", body: { message: ask } },
        expect: { status: 200, events: { include: ["done"] } },
      },
    ],
  };
  return {
    id: input.scenarioId,
    target_id: input.targetId,
    bundle_id: input.bundleId,
    feature_id: REPLAY_FEATURE_ID,
    cell_id: null,
    title,
    family: REPLAY_FAMILY,
    origin: "replay",
    status: input.status,
    version: 1,
    yaml: renderScenarioYaml(doc),
    parsed: JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    synthetic: false,
    validation: { valid: true, errors: [], warnings: [] },
    provenance: {
      source: "replay",
      replay_id: input.replayId,
      bundle_version: input.bundleVersion,
    },
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

export function registerReplayScenario(state: MockState, scenario: Scenario): void {
  if (state.stageTwo.findScenario(scenario.id) === undefined) {
    state.stageTwo.addScenario({ scenario, cellKey: null });
  }
}
