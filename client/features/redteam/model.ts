import type { KnownStreamEvent } from "@/features/streams/events";
import type { AttackOutcome, RedTeamRound, Severity } from "@/lib/api/types";
import { DRY_ROUNDS_TO_STOP } from "./labels";

export interface LiveAttack {
  attackId: string;
  outcome: AttackOutcome;
}

export interface LiveRound {
  id: string;
  index: number;
  family: string;
  attacks: LiveAttack[];
  finished: boolean;
  dry: boolean;
  candidates: number;
  attackCount: number;
}

export interface LandedFinding {
  id: string;
  title: string;
  severity: Severity;
}

export interface RedteamLiveSummary {
  rounds: LiveRound[];
  findings: LandedFinding[];
  lastSeq: number;
}

export interface RoundView {
  id: string;
  index: number;
  family: string;
  attacks: number;
  candidates: number;
  dry: boolean;
  finished: boolean;
  startedAt: string | null;
}

function emptyRound(id: string, family: string): LiveRound {
  return {
    id,
    index: 0,
    family,
    attacks: [],
    finished: false,
    dry: false,
    candidates: 0,
    attackCount: 0,
  };
}

export function summarizeRedteamEvents(events: readonly KnownStreamEvent[]): RedteamLiveSummary {
  const rounds = new Map<string, LiveRound>();
  const findings: LandedFinding[] = [];
  let lastSeq = 0;
  for (const event of events) {
    switch (event.type) {
      case "redteam.round_started": {
        const { round_id: id, index, family } = event.payload;
        const existing = rounds.get(id) ?? emptyRound(id, family);
        rounds.set(id, { ...existing, index, family });
        lastSeq = event.seq ?? lastSeq;
        break;
      }
      case "redteam.attack": {
        const { attack_id: attackId, round_id: id, family, outcome } = event.payload;
        const existing = rounds.get(id) ?? emptyRound(id, family);
        if (!existing.attacks.some((attack) => attack.attackId === attackId)) {
          const attacks = [...existing.attacks, { attackId, outcome }];
          rounds.set(id, {
            ...existing,
            attacks,
            attackCount: Math.max(existing.attackCount, attacks.length),
            candidates: attacks.filter((attack) => attack.outcome === "breached").length,
          });
        }
        lastSeq = event.seq ?? lastSeq;
        break;
      }
      case "redteam.round_finished": {
        const { round_id: id, index, attacks, candidates, dry } = event.payload;
        const existing = rounds.get(id) ?? emptyRound(id, "");
        rounds.set(id, {
          ...existing,
          index,
          finished: true,
          dry,
          attackCount: attacks,
          candidates,
        });
        lastSeq = event.seq ?? lastSeq;
        break;
      }
      case "finding.created":
        if (!findings.some((finding) => finding.id === event.payload.finding_id)) {
          findings.push({
            id: event.payload.finding_id,
            title: event.payload.title,
            severity: event.payload.severity,
          });
        }
        lastSeq = event.seq ?? lastSeq;
        break;
      default:
        break;
    }
  }
  return { rounds: [...rounds.values()], findings, lastSeq };
}

export function roundViewOfRest(round: RedTeamRound): RoundView {
  return {
    id: round.id,
    index: round.index,
    family: round.family,
    attacks: round.attacks,
    candidates: round.candidates,
    dry: round.finished_at !== null && round.dry,
    finished: round.finished_at !== null,
    startedAt: round.started_at,
  };
}

export function roundViewOfLive(round: LiveRound): RoundView {
  return {
    id: round.id,
    index: round.index,
    family: round.family,
    attacks: round.attackCount,
    candidates: round.candidates,
    dry: round.finished && round.dry,
    finished: round.finished,
    startedAt: null,
  };
}

function fresher(left: RoundView, right: RoundView): RoundView {
  if (left.finished !== right.finished) {
    return left.finished ? left : right;
  }
  return right.attacks > left.attacks ? right : left;
}

export function mergeRoundViews(
  restRounds: readonly RedTeamRound[],
  liveRounds: readonly LiveRound[],
): RoundView[] {
  const merged = new Map<string, RoundView>();
  for (const view of [...restRounds.map(roundViewOfRest), ...liveRounds.map(roundViewOfLive)]) {
    const known = merged.get(view.id);
    const chosen = known === undefined ? view : fresher(known, view);
    merged.set(view.id, {
      ...chosen,
      family: chosen.family === "" ? (known?.family ?? view.family) : chosen.family,
      index: chosen.index === 0 ? Math.max(known?.index ?? 0, view.index) : chosen.index,
      startedAt: chosen.startedAt ?? known?.startedAt ?? view.startedAt,
    });
  }
  return [...merged.values()].sort((left, right) => left.index - right.index);
}

export function countTrailingDry(rounds: readonly RoundView[]): number {
  const finished = rounds.filter((round) => round.finished);
  let count = 0;
  for (let position = finished.length - 1; position >= 0; position -= 1) {
    if (finished[position]?.dry !== true) {
      break;
    }
    count += 1;
  }
  return count;
}

export function isStoppingForDryRounds(rounds: readonly RoundView[], runActive: boolean): boolean {
  return runActive && countTrailingDry(rounds) >= DRY_ROUNDS_TO_STOP;
}

export function describeRoundsAnnouncement(rounds: readonly RoundView[]): string {
  const latest = rounds.at(-1);
  if (latest === undefined) {
    return "Waiting for the first round";
  }
  const dry = countTrailingDry(rounds);
  const state = latest.finished
    ? latest.dry
      ? "finished dry"
      : `finished with ${latest.candidates} ${latest.candidates === 1 ? "candidate" : "candidates"}`
    : "in progress";
  return `Round ${latest.index} ${state}. ${dry} ${dry === 1 ? "dry round" : "dry rounds"} in a row.`;
}
