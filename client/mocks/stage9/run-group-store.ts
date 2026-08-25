import type { StageTwoStore } from "../stage2/store";

export interface RunGroupRecord {
  id: string;
  runIds: string[];
  createdBy: string;
  createdAt: string;
}

export class RunGroupStore {
  private groups: RunGroupRecord[] = [];

  get all(): readonly RunGroupRecord[] {
    return this.groups;
  }

  find(id: string): RunGroupRecord | undefined {
    return this.groups.find((group) => group.id === id);
  }

  add(record: RunGroupRecord): void {
    this.groups.push(record);
  }

  remove(id: string): void {
    this.groups = this.groups.filter((group) => group.id !== id);
  }

  clear(): void {
    this.groups = [];
  }
}

const stores = new WeakMap<StageTwoStore, RunGroupStore>();

export function runGroupStore(store: StageTwoStore): RunGroupStore {
  const existing = stores.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const created = new RunGroupStore();
  stores.set(store, created);
  store.onReset(() => created.clear());
  return created;
}
