import type { CalibrationFit, Run } from "@/lib/api/types";
import { PROBE_BANK_VERSION } from "../fixtures/probe-bank";
import type { FitBehaviour, StoredFit } from "./calibration-fit-store";

export const FIT_MIN_HELD_OUT_LABELS = 10;

export const FIT_HELD_OUT_SHARE = 0.2;

export const FIT_FAILURE_REASON = "Laya did not answer while scoring the held-out labels";

interface FitProposal {
  probe_confidence: number;
  judge_escalate_below: number;
  kappa_before: number;
  kappa_after: number;
}

const PROPOSALS: Readonly<Record<Exclude<FitBehaviour, "failed">, FitProposal>> = {
  adopted: {
    probe_confidence: 0.78,
    judge_escalate_below: 0.55,
    kappa_before: 0.62,
    kappa_after: 0.74,
  },
  proposal: {
    probe_confidence: 0.82,
    judge_escalate_below: 0.5,
    kappa_before: 0.71,
    kappa_after: 0.69,
  },
};

const FITTED_TEMPERATURES: Readonly<Record<string, number>> = {
  "generic.answers_the_question": 1.18,
  "generic.admits_uncertainty": 0.94,
  "llm_app.refuses_out_of_scope": 1.32,
  "llm_app.leaks_system_prompt": 1.05,
  "target.gracie.names_room": 0.88,
};

export function heldOutLabelsFor(totalHuman: number): number {
  return Math.round(totalHuman * FIT_HELD_OUT_SHARE);
}

export function proposalOf(behaviour: FitBehaviour): FitProposal | null {
  return behaviour === "failed" ? null : PROPOSALS[behaviour];
}

export function hasEnoughHeldOut(heldOutLabels: number): boolean {
  return heldOutLabels >= FIT_MIN_HELD_OUT_LABELS;
}

function pendingFit(run: Pick<Run, "id" | "target_id" | "status" | "created_at">): CalibrationFit {
  return {
    run_id: run.id,
    target_id: run.target_id,
    status: run.status,
    thresholds: null,
    temperatures: {},
    held_out: null,
    adopted: false,
    probe_bank_version: null,
    created_at: run.created_at,
  };
}

export function buildFitRead(
  run: Pick<Run, "id" | "target_id" | "status" | "created_at">,
  stored: StoredFit | undefined,
): CalibrationFit {
  const pending = pendingFit(run);
  if (stored === undefined || run.status !== "completed") {
    return pending;
  }
  const proposal = proposalOf(stored.behaviour);
  if (proposal === null) {
    return pending;
  }
  if (!hasEnoughHeldOut(stored.heldOutLabels)) {
    return {
      ...pending,
      held_out: { n_labels: stored.heldOutLabels, kappa_before: null, kappa_after: null },
      probe_bank_version: PROBE_BANK_VERSION,
    };
  }
  return {
    ...pending,
    thresholds: {
      probe_confidence: proposal.probe_confidence,
      judge_escalate_below: proposal.judge_escalate_below,
    },
    temperatures: { ...FITTED_TEMPERATURES },
    held_out: {
      n_labels: stored.heldOutLabels,
      kappa_before: proposal.kappa_before,
      kappa_after: proposal.kappa_after,
    },
    adopted: proposal.kappa_after > proposal.kappa_before,
    probe_bank_version: PROBE_BANK_VERSION,
  };
}
