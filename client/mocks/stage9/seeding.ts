import type { MockState } from "../state";

export type StageNineSeed = "default" | "empty";

export type StageNineSeeder = (seed: StageNineSeed, state: MockState) => unknown;

const seeders = new Map<string, StageNineSeeder>();

export function registerStageNineSeeder(name: string, seeder: StageNineSeeder): void {
  seeders.set(name, seeder);
}

export function applyStageNineSeed(
  seed: StageNineSeed,
  state: MockState,
): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const [name, seeder] of seeders) {
    results[name] = seeder(seed, state) ?? null;
  }
  return results;
}

export function stageNineSeederNames(): string[] {
  return [...seeders.keys()];
}
