import type { ContractDiff } from "@/lib/api/types";
import type { ContractBehavior } from "./contracts-data";

export interface ContractEntry {
  id: string;
  runId: string;
  consumerBundleId: string;
  providerBundleId: string;
  consumerTargetId: string;
  providerTargetId: string;
  createdAt: string;
  items: ContractDiff[];
  revealed: number;
  failAfter: number | null;
  failReason: string | null;
  itemGapMs: number;
}

export interface ContractRunParams {
  contract_check_id: string;
}

export function readContractRunParams(params: Record<string, unknown>): ContractRunParams {
  return {
    contract_check_id: typeof params.contract_check_id === "string" ? params.contract_check_id : "",
  };
}

export class ContractStore {
  private rows: ContractEntry[] = [];
  nextBehavior: ContractBehavior = "normal";
  seeded = false;
  resetBound = false;

  get entries(): readonly ContractEntry[] {
    return this.rows;
  }

  reset(): void {
    this.rows = [];
    this.nextBehavior = "normal";
    this.seeded = false;
  }

  add(entry: ContractEntry): void {
    this.rows.push(entry);
  }

  find(contractCheckId: string): ContractEntry | undefined {
    return this.rows.find((entry) => entry.id === contractCheckId);
  }

  findByRun(runId: string): ContractEntry | undefined {
    return this.rows.find((entry) => entry.runId === runId);
  }

  consumeBehavior(): ContractBehavior {
    const behavior = this.nextBehavior;
    this.nextBehavior = "normal";
    return behavior;
  }
}

export const contractStore = new ContractStore();
