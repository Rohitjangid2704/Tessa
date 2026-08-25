import type { StepContent } from "../simulation/step-content";
import { stableInt } from "../stage2/ids";
import type { ArtifactSpec } from "../stage2/types";
import type { BrowserAction } from "@/lib/api/types";
import type { ExploreMove, ExplorePage } from "./explore-narrative";

export const EXPLORE_STEP_COST_USD = 0.012;

const BROWSER_ARTIFACTS: ArtifactSpec[] = [
  { kind: "screenshot", fixture: "png", key: "shot" },
  { kind: "recording", fixture: "webm" },
  { kind: "trace", fixture: "zip" },
];

const ACTION_VERBS: Record<string, string> = {
  navigate: "Open",
  click: "Click",
  type: "Type into",
  read: "Read",
};

function browserActionOf(action: ExploreMove["action"]): BrowserAction {
  return action === "finish" ? "wait" : action;
}

function labelOf(move: ExploreMove, page: ExplorePage): string {
  const verb = ACTION_VERBS[move.action] ?? "Do";
  if (move.action === "navigate") {
    return `${verb} ${page.path}`;
  }
  return `${verb} ${move.target ?? page.path}`;
}

export interface ExploreStepInput {
  move: ExploreMove;
  page: ExplorePage;
  webBase: string;
  seed: string;
  costUsd: number;
}

export function exploreStepContent({
  move,
  page,
  webBase,
  seed,
  costUsd,
}: ExploreStepInput): StepContent {
  const url = `${webBase}${page.path}`;
  return {
    adapter: "browser",
    label: labelOf(move, page),
    request: {
      kind: "browser",
      action: browserActionOf(move.action),
      target: move.target,
      text: move.text,
      url: move.action === "navigate" ? (move.url ?? url) : null,
    },
    response: {
      kind: "browser",
      url,
      title: page.title,
      text_excerpt: page.excerpt,
      console: [],
      dom_state: null,
    },
    response_truncated: false,
    payload_purged: false,
    ask: null,
    answer: null,
    tools: [],
    cards: [],
    latency_ms: stableInt(280, 900, "explore_step_latency", seed),
    cost_usd: costUsd,
    tier0: { passed: true, failures: [] },
    ok: true,
    artifacts: BROWSER_ARTIFACTS,
    verdict: null,
  };
}
