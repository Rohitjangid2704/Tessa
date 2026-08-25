import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { launchRun } from "../server/run-simulator";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { BundleRecord, TargetRecord } from "../stage1/store";
import { buildConfigSnapshot } from "../stage2/plan-service";
import type { StageTwoStore } from "../stage2/store";
import { reviewScenarioId } from "../stage6/review-queue";
import { mockState, type MockState } from "../state";
import "../streams/redteam-script";
import "../streams/replay-script";
import { FAKE_EXCERPTS } from "./replay-data";
import { REDTEAM_REPLAY_IDS, REPLAY_SEED_TIMES } from "./redteam-replay-ids";
import { buildReplayEntry, type RecordDraft, type ReplayParams } from "./replay-service";
import { replayStore } from "./replay-store";
import type { RedteamRunParams } from "./redteam-service";
import { redteamStore } from "./redteam-store";
import { registerStageSevenSeeder, type StageSevenSeed } from "./seeding";

const NO_MESSAGES = "[no readable messages]";
const REDTEAM_BUDGET = { max_usd: 2, max_minutes: 15 };
const LATE_CHECKOUT_KEY = "replay_late_checkout";

export function resetRedteamReplayStores(): void {
  redteamStore.reset();
  replayStore.reset();
}

function excerptAt(index: number): string {
  return FAKE_EXCERPTS[index % FAKE_EXCERPTS.length] ?? NO_MESSAGES;
}

function trafficDrafts(targetId: string): RecordDraft[] {
  const rejected = (index: number, reasonCode: RecordDraft["reasonCode"]): RecordDraft => ({
    excerpt: reasonCode === "invalid" ? NO_MESSAGES : excerptAt(index),
    reasonCode,
  });
  const created = (index: number, status: "in_review" | "accepted"): RecordDraft => ({
    excerpt: excerptAt(index),
    reasonCode: null,
    scenarioStatus: status,
  });
  return [
    {
      excerpt: excerptAt(0),
      reasonCode: null,
      scenarioId: reviewScenarioId(targetId, LATE_CHECKOUT_KEY),
      scenarioStatus: "in_review",
    },
    created(1, "in_review"),
    created(2, "in_review"),
    created(3, "accepted"),
    rejected(4, "duplicate"),
    created(5, "accepted"),
    rejected(6, "unstable"),
    created(7, "accepted"),
    rejected(8, "invalid"),
    created(9, "accepted"),
    rejected(10, "validation_failed"),
    created(11, "accepted"),
    rejected(12, "over_record_cap"),
    rejected(13, "over_record_cap"),
  ];
}

function partnerDrafts(): RecordDraft[] {
  const reasons: RecordDraft["reasonCode"][] = [
    "invalid",
    "duplicate",
    "invalid",
    "duplicate",
    "invalid",
    "duplicate",
  ];
  return reasons.map((reasonCode, index) => ({
    excerpt: reasonCode === "invalid" ? NO_MESSAGES : excerptAt(index),
    reasonCode,
  }));
}

interface SeededReplay {
  replayId: string;
  runId: string;
  sourceName: string;
  at: string;
  createdBy: string;
  drafts: RecordDraft[];
}

function launchSeededReplay(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
  seeded: SeededReplay,
): void {
  replayStore.add(
    buildReplayEntry({
      replayId: seeded.replayId,
      runId: seeded.runId,
      targetId: target.id,
      sourceName: seeded.sourceName,
      createdAt: seeded.at,
      drafts: seeded.drafts,
    }),
  );
  const params: ReplayParams = { replay_id: seeded.replayId };
  const baseMs = Date.parse(seeded.at);
  launchRun(state, store, {
    id: seeded.runId,
    kind: "replay",
    createdBy: seeded.createdBy,
    targetId: target.id,
    planId: null,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: { max_usd: 5, max_minutes: 30 },
    configSnapshot: buildConfigSnapshot(record, seeded.at),
    params: { ...params },
    createdAtMs: baseMs,
    mode: { kind: "instant", baseMs },
  });
}

export function seedRedteamReplayHistory(
  state: MockState,
  store: StageTwoStore,
  target: TargetRecord,
  record: BundleRecord,
): void {
  if (store.findRun(REDTEAM_REPLAY_IDS.runs.redteam) !== undefined) {
    return;
  }
  const redteamParams: RedteamRunParams = {
    target_id: target.id,
    role: "guest",
    families: ["prompt_injection", "internal_id_extraction", "role_escalation"],
    max_rounds: 10,
  };
  const redteamAt = Date.parse(REPLAY_SEED_TIMES.redteam);
  launchRun(state, store, {
    id: REDTEAM_REPLAY_IDS.runs.redteam,
    kind: "redteam",
    createdBy: ADMIN_USER.id,
    targetId: target.id,
    planId: null,
    bundleId: record.bundle.id,
    readOnly: false,
    budget: { ...REDTEAM_BUDGET },
    configSnapshot: buildConfigSnapshot(record, REPLAY_SEED_TIMES.redteam),
    params: { ...redteamParams },
    createdAtMs: redteamAt,
    mode: { kind: "instant", baseMs: redteamAt },
  });
  launchSeededReplay(state, store, target, record, {
    replayId: REDTEAM_REPLAY_IDS.replays.partner,
    runId: REDTEAM_REPLAY_IDS.runs.replayPartner,
    sourceName: "partner-chat-export.jsonl",
    at: REPLAY_SEED_TIMES.replayPartner,
    createdBy: MEMBER_USER.id,
    drafts: partnerDrafts(),
  });
  launchSeededReplay(state, store, target, record, {
    replayId: REDTEAM_REPLAY_IDS.replays.traffic,
    runId: REDTEAM_REPLAY_IDS.runs.replayTraffic,
    sourceName: "traffic-2026-09-30.jsonl",
    at: REPLAY_SEED_TIMES.replayTraffic,
    createdBy: ADMIN_USER.id,
    drafts: trafficDrafts(target.id),
  });
}

function clearRedteamReplayRuns(store: StageTwoStore): void {
  const replayIds = new Set(replayStore.entries.map((entry) => entry.replayId));
  const runs = store.runs;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const kind = runs[index]?.run.kind;
    if (kind === "redteam" || kind === "replay") {
      runs.splice(index, 1);
    }
  }
  const scenarios = store.scenarios;
  for (let index = scenarios.length - 1; index >= 0; index -= 1) {
    const replayId = scenarios[index]?.scenario.provenance?.replay_id;
    if (typeof replayId === "string" && replayIds.has(replayId)) {
      scenarios.splice(index, 1);
    }
  }
}

function reseedRedteamReplay(seed: StageSevenSeed): void {
  const store = mockState.stageTwo;
  store.ensure();
  clearRedteamReplayRuns(store);
  resetRedteamReplayStores();
  if (seed === "empty") {
    return;
  }
  const target = mockState.stageOne.findTarget(STAGE_ONE_IDS.gracie);
  const record = target === undefined ? undefined : mockState.stageOne.latestValidBundle(target.id);
  if (target !== undefined && record !== undefined) {
    seedRedteamReplayHistory(mockState, store, target, record);
  }
}

registerStageSevenSeeder("redteam-replay", reseedRedteamReplay);
