import { buildFinding } from "../factories/finding";
import { registerRunScript } from "../server/run-simulator";
import { stableId } from "../stage2/ids";
import type { RunScript, RunScriptFactory, ScriptAction, ScriptContext } from "../simulation/script";
import {
  DRY_ROUND_OUTCOMES,
  REDTEAM_FAMILIES,
  REDTEAM_SCRIPT_ROUNDS,
  ROUND_ONE_OUTCOMES,
  SKEPTIC_VERDICTS,
  templateFor,
} from "../stage7/redteam-data";
import { readRedteamParams, type RedteamRunParams } from "../stage7/redteam-service";
import { redteamStore, type AttackRecord } from "../stage7/redteam-store";
import { emitRaw, isInstant, stampOf } from "../stage7/raw-events";
import { isRunStopRequested } from "../stage7/stop-requests";
import type {
  Attack,
  AttackOutcome,
  Finding,
  RedTeamRound,
  RedteamAttackPayload,
  RedteamRoundFinishedPayload,
  RedteamRoundStartedPayload,
  Verdict,
} from "@/lib/api/types";

const PLANNING_AT_MS = 300;
const RUNNING_AT_MS = 700;
const FIRST_ROUND_AT_MS = 1000;
const ATTACK_GAP_MS = 650;
const SKEPTIC_GAP_MS = 900;
const ROUND_CLOSE_GAP_MS = 350;
const ROUND_GAP_MS = 600;
const FINISH_GAP_MS = 500;
const ATTACK_COST_USD = 0.05;
const SKEPTIC_COST_USD = 0.1;
const ORDINAL_STRIDE = 100;

const SECURITY_FAMILIES: readonly string[] = [
  "role_escalation",
  "data_exfiltration",
  "internal_id_extraction",
];

interface PendingSkeptic {
  attackId: string;
  verdict: Verdict;
}

function roundIdOf(runId: string, index: number): string {
  return stableId("redteam_round", runId, index);
}

function attackIdOf(runId: string, roundIndex: number, attackIndex: number): string {
  return stableId("attack", runId, roundIndex, attackIndex);
}

function titleOfFamily(familyId: string): string {
  return REDTEAM_FAMILIES.find((family) => family.id === familyId)?.title ?? familyId;
}

function startRound(context: ScriptContext, runId: string, index: number, family: string): void {
  if (isRunStopRequested(runId)) {
    return;
  }
  const round: RedTeamRound = {
    id: roundIdOf(runId, index),
    run_id: runId,
    index,
    family,
    dry: false,
    attacks: 0,
    candidates: 0,
    started_at: stampOf(context),
    finished_at: null,
  };
  redteamStore.addRound(round);
  const payload: RedteamRoundStartedPayload = { round_id: round.id, index, family };
  emitRaw(context, "redteam.round_started", payload);
}

function runAttack(
  context: ScriptContext,
  runId: string,
  roundIndex: number,
  attackIndex: number,
  outcome: AttackOutcome,
): void {
  const round = redteamStore.findRound(roundIdOf(runId, roundIndex));
  if (round === undefined || isRunStopRequested(runId)) {
    return;
  }
  const template = templateFor(round.family);
  const prompt = template.prompts[(roundIndex + attackIndex) % template.prompts.length] ?? "";
  const attack: Attack = {
    id: attackIdOf(runId, roundIndex, attackIndex),
    round_id: round.id,
    family: round.family,
    prompt_excerpt: prompt,
    response_excerpt: template.responses[outcome],
    outcome,
    skeptic_verdict: null,
    finding_id: null,
  };
  const record: AttackRecord = {
    attack,
    runId,
    ordinal: roundIndex * ORDINAL_STRIDE + attackIndex,
  };
  redteamStore.addAttack(record);
  round.attacks += 1;
  if (outcome === "breached") {
    round.candidates += 1;
  }
  const payload: RedteamAttackPayload = {
    attack_id: attack.id,
    round_id: round.id,
    family: attack.family,
    outcome,
  };
  emitRaw(context, "redteam.attack", payload);
  context.addSpend(ATTACK_COST_USD);
  context.bumpCounters({ scenarios_total: 1 });
  context.tickProgress();
}

function seededFindingFor(context: ScriptContext, ordinal: number): Finding | null {
  const candidates = context.state.stageFive.findings.all.filter(
    (finding) => finding.class === "security_boundary" || finding.class === "safety_claim",
  );
  return candidates[ordinal % Math.max(1, candidates.length)] ?? null;
}

function createBoardFinding(context: ScriptContext, record: AttackRecord): Finding {
  const { attack } = record;
  const security = SECURITY_FAMILIES.includes(attack.family);
  const startedAt = stampOf(context);
  const finding = buildFinding({
    id: stableId("finding", "redteam", attack.id),
    target_id: context.run.target_id ?? "",
    title: `Red team: ${titleOfFamily(attack.family)} got through`,
    class: security ? "security_boundary" : "safety_claim",
    severity: security ? "high" : "medium",
    status: "new",
    first_seen_at: startedAt,
    last_seen_at: startedAt,
    first_seen_run_id: record.runId,
    last_seen_run_id: record.runId,
    expected: "The reply refuses or stays inside the role",
    actual: attack.response_excerpt,
  });
  context.state.stageFive.findings.add({ finding, runIds: [record.runId] });
  return finding;
}

function verifyCandidate(context: ScriptContext, pending: PendingSkeptic): void {
  const record = redteamStore.findAttack(pending.attackId);
  if (record === undefined) {
    return;
  }
  record.attack.skeptic_verdict = pending.verdict;
  context.addSpend(SKEPTIC_COST_USD);
  context.tickProgress();
  if (pending.verdict.status === "pass") {
    context.bumpCounters({ scenarios_done: 1, pass: 1 });
    return;
  }
  if (pending.verdict.status !== "fail") {
    context.bumpCounters({ scenarios_done: 1, uncertain: 1 });
    return;
  }
  const finding = isInstant(context)
    ? seededFindingFor(context, record.ordinal)
    : createBoardFinding(context, record);
  context.bumpCounters({ scenarios_done: 1, fail: 1 });
  if (finding === null) {
    return;
  }
  record.attack.finding_id = finding.id;
  emitRaw(context, "finding.created", {
    finding_id: finding.id,
    title: finding.title,
    class: finding.class,
    severity: finding.severity,
    status: finding.status,
    fingerprint: finding.fingerprint,
    is_new: true,
    scenario_id: finding.scenario_id,
  });
}

function finishRound(context: ScriptContext, runId: string, index: number): void {
  const round = redteamStore.findRound(roundIdOf(runId, index));
  if (round === undefined) {
    return;
  }
  round.dry = round.candidates === 0;
  round.finished_at = stampOf(context);
  const payload: RedteamRoundFinishedPayload = {
    round_id: round.id,
    index,
    attacks: round.attacks,
    candidates: round.candidates,
    dry: round.dry,
  };
  emitRaw(context, "redteam.round_finished", payload);
  context.tickProgress();
}

function settleNonBreaches(context: ScriptContext, runId: string, roundIndex: number): void {
  const round = redteamStore.findRound(roundIdOf(runId, roundIndex));
  if (round === undefined) {
    return;
  }
  const settled = redteamStore
    .attacksOfRound(round.id)
    .filter((record) => record.attack.outcome !== "breached");
  const blocked = settled.filter((record) => record.attack.outcome === "blocked").length;
  context.bumpCounters({
    scenarios_done: settled.length,
    pass: blocked,
    uncertain: settled.length - blocked,
  });
  context.tickProgress();
}

function planRounds(params: RedteamRunParams): number {
  return Math.min(REDTEAM_SCRIPT_ROUNDS, params.max_rounds ?? REDTEAM_SCRIPT_ROUNDS);
}

export const redteamRunFactory: RunScriptFactory = ({ run, params }): RunScript => {
  const request = readRedteamParams(params);
  const runId = run.id;
  const actions: ScriptAction[] = [
    { atMs: 0, label: "created", checkpoint: "created", run: () => undefined },
    { atMs: PLANNING_AT_MS, label: "planning", run: (context) => context.setStatus("planning") },
    {
      atMs: RUNNING_AT_MS,
      label: "running",
      checkpoint: "running",
      run: (context) => context.setStatus("running"),
    },
  ];
  let at = FIRST_ROUND_AT_MS;
  let breachOrdinal = 0;
  const rounds = planRounds(request);
  for (let index = 1; index <= rounds; index += 1) {
    const family = request.families[(index - 1) % request.families.length] ?? "prompt_injection";
    const outcomes = index === 1 ? ROUND_ONE_OUTCOMES : DRY_ROUND_OUTCOMES;
    actions.push({
      atMs: at,
      label: `round ${index} started`,
      run: (context) => startRound(context, runId, index, family),
    });
    at += ATTACK_GAP_MS;
    const pending: PendingSkeptic[] = [];
    outcomes.forEach((outcome, attackIndex) => {
      actions.push({
        atMs: at,
        label: `round ${index} attack ${attackIndex + 1}`,
        checkpoint: index === 1 && attackIndex === 0 ? "first_step" : undefined,
        run: (context) => runAttack(context, runId, index, attackIndex, outcome),
      });
      if (outcome === "breached") {
        const verdict = SKEPTIC_VERDICTS[breachOrdinal % SKEPTIC_VERDICTS.length];
        breachOrdinal += 1;
        if (verdict !== undefined) {
          pending.push({ attackId: attackIdOf(runId, index, attackIndex), verdict });
        }
      }
      at += ATTACK_GAP_MS;
    });
    actions.push({
      atMs: at,
      label: `round ${index} settle`,
      run: (context) => settleNonBreaches(context, runId, index),
    });
    for (const item of pending) {
      at += SKEPTIC_GAP_MS;
      actions.push({
        atMs: at,
        label: `skeptic ${item.attackId.slice(-4)}`,
        run: (context) => verifyCandidate(context, item),
      });
    }
    at += ROUND_CLOSE_GAP_MS;
    actions.push({
      atMs: at,
      label: `round ${index} finished`,
      run: (context) => finishRound(context, runId, index),
    });
    at += ROUND_GAP_MS;
  }
  actions.push({
    atMs: at + FINISH_GAP_MS / 2,
    label: "finishing",
    checkpoint: "finishing",
    run: () => undefined,
  });
  actions.push({
    atMs: at + FINISH_GAP_MS,
    label: "finish",
    run: (context) => {
      context.flushProgress();
      context.finish("completed");
    },
  });
  return { actions };
};

registerRunScript("redteam", redteamRunFactory);
