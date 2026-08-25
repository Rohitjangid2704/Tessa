import { validationFailed } from "../factories/errors";
import type { MockState } from "../state";
import { AGENT_SESSION_VARIANTS, type AgentSessionsVariant } from "./agent-sessions-data";
import { agentSessionsStore } from "./agent-sessions-store";
import {
  registerStageElevenSeeder,
  type StageElevenSeed,
  type StageElevenVariants,
} from "./seeding";

const SEEDER_NAME = "agent_sessions";

function resolveVariant(
  seed: StageElevenSeed,
  variants: StageElevenVariants,
): AgentSessionsVariant {
  const requested = variants[SEEDER_NAME];
  if (requested === undefined) {
    return seed === "empty" ? "none" : "default";
  }
  const match = AGENT_SESSION_VARIANTS.find((variant) => variant === requested);
  if (match === undefined) {
    throw validationFailed([
      {
        loc: ["body", "variants", SEEDER_NAME],
        code: "enum",
        message: `Input should be ${AGENT_SESSION_VARIANTS.join(", ")}`,
      },
    ]);
  }
  return match;
}

export function seedAgentSessions(
  seed: StageElevenSeed,
  _state: MockState,
  variants: StageElevenVariants,
) {
  const variant = resolveVariant(seed, variants);
  agentSessionsStore.load(variant);
  return { variant, count: agentSessionsStore.count() };
}

registerStageElevenSeeder(SEEDER_NAME, seedAgentSessions);
