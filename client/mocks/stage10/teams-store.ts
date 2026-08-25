import { newId } from "../factories/ids";
import { mockState, type MockState } from "../state";
import { seededTeams, type TeamsVariant } from "./teams-data";

export interface TeamRecord {
  id: string;
  name: string;
  maxUsdMonth: number | null;
  spentMonthUsd: number;
  createdAt: string;
}

export class TeamsStore {
  private rows: TeamRecord[] = [];
  private readonly targetTeams = new Map<string, string>();
  private variantName: TeamsVariant = "default";
  private loaded = false;

  get currentVariant(): TeamsVariant {
    return this.variantName;
  }

  get all(): readonly TeamRecord[] {
    this.ensure();
    return this.rows;
  }

  load(variant: TeamsVariant): void {
    this.rows = [];
    this.targetTeams.clear();
    for (const seeded of seededTeams(variant)) {
      this.rows.push({
        id: seeded.id,
        name: seeded.name,
        maxUsdMonth: seeded.maxUsdMonth,
        spentMonthUsd: seeded.spentMonthUsd,
        createdAt: seeded.createdAt,
      });
      for (const targetId of seeded.targetIds) {
        this.targetTeams.set(targetId, seeded.id);
      }
    }
    this.variantName = variant;
    this.loaded = true;
  }

  find(teamId: string): TeamRecord | undefined {
    return this.all.find((team) => team.id === teamId);
  }

  findByName(name: string, exceptTeamId?: string): TeamRecord | undefined {
    const wanted = name.trim().toLowerCase();
    return this.all.find(
      (team) => team.id !== exceptTeamId && team.name.trim().toLowerCase() === wanted,
    );
  }

  create(name: string): TeamRecord {
    const record: TeamRecord = {
      id: newId(),
      name,
      maxUsdMonth: null,
      spentMonthUsd: 0,
      createdAt: new Date().toISOString(),
    };
    this.ensure();
    this.rows.push(record);
    return record;
  }

  teamIdOfTarget(targetId: string): string | null {
    this.ensure();
    return this.targetTeams.get(targetId) ?? null;
  }

  teamOfTarget(targetId: string): TeamRecord | undefined {
    const teamId = this.teamIdOfTarget(targetId);
    return teamId === null ? undefined : this.find(teamId);
  }

  setTargetTeam(targetId: string, teamId: string | null): void {
    this.ensure();
    if (teamId === null) {
      this.targetTeams.delete(targetId);
      return;
    }
    this.targetTeams.set(targetId, teamId);
  }

  reset(): void {
    this.rows = [];
    this.targetTeams.clear();
    this.variantName = "default";
    this.loaded = false;
  }

  private ensure(): void {
    if (!this.loaded) {
      this.load("default");
    }
  }
}

const stores = new WeakMap<MockState, TeamsStore>();

export function teamsStore(state: MockState): TeamsStore {
  const existing = stores.get(state);
  if (existing !== undefined) {
    return existing;
  }
  const created = new TeamsStore();
  stores.set(state, created);
  state.stageTwo.onReset(() => created.reset());
  return created;
}

export function teamIdOfTargetId(targetId: string): string | null {
  return teamsStore(mockState).teamIdOfTarget(targetId);
}
