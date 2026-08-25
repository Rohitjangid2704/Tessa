import { mockState, type MockState } from "../state";

export class JevConsentStore {
  private readonly allowedTargetIds = new Set<string>();

  isAllowed(targetId: string): boolean {
    return this.allowedTargetIds.has(targetId);
  }

  set(targetId: string, allowed: boolean): void {
    if (allowed) {
      this.allowedTargetIds.add(targetId);
      return;
    }
    this.allowedTargetIds.delete(targetId);
  }

  reset(): void {
    this.allowedTargetIds.clear();
  }
}

const stores = new WeakMap<MockState, JevConsentStore>();

export function jevConsentStore(state: MockState): JevConsentStore {
  const existing = stores.get(state);
  if (existing !== undefined) {
    return existing;
  }
  const created = new JevConsentStore();
  stores.set(state, created);
  state.stageTwo.onReset(() => created.reset());
  return created;
}

export function allowJevOfTargetId(targetId: string): boolean {
  return jevConsentStore(mockState).isAllowed(targetId);
}

export function applyTargetJevConsent(
  state: MockState,
  targetId: string,
  allowJev: boolean | null | undefined,
): void {
  if (typeof allowJev === "boolean") {
    jevConsentStore(state).set(targetId, allowJev);
  }
}
