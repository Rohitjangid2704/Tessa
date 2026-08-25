import type { Attack, RedTeamRound } from "@/lib/api/types";

export interface AttackRecord {
  attack: Attack;
  runId: string;
  ordinal: number;
}

export class RedteamStore {
  private readonly roundRows: RedTeamRound[] = [];
  private readonly attackRows: AttackRecord[] = [];

  get rounds(): readonly RedTeamRound[] {
    return this.roundRows;
  }

  get attacks(): readonly AttackRecord[] {
    return this.attackRows;
  }

  reset(): void {
    this.roundRows.length = 0;
    this.attackRows.length = 0;
  }

  addRound(round: RedTeamRound): void {
    this.roundRows.push(round);
  }

  findRound(roundId: string): RedTeamRound | undefined {
    return this.roundRows.find((round) => round.id === roundId);
  }

  addAttack(record: AttackRecord): void {
    this.attackRows.push(record);
  }

  findAttack(attackId: string): AttackRecord | undefined {
    return this.attackRows.find((record) => record.attack.id === attackId);
  }

  roundsOfRun(runId: string): RedTeamRound[] {
    return this.roundRows.filter((round) => round.run_id === runId);
  }

  attacksOfRound(roundId: string): AttackRecord[] {
    return this.attackRows.filter((record) => record.attack.round_id === roundId);
  }
}

export const redteamStore = new RedteamStore();
