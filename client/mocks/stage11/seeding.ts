import type { MockState } from "../state";

export type StageElevenSeed = "default" | "empty";

export type StageElevenVariants = Readonly<Record<string, string>>;

export type StageElevenSeeder = (
  seed: StageElevenSeed,
  state: MockState,
  variants: StageElevenVariants,
) => unknown;

const seeders = new Map<string, StageElevenSeeder>();

export function registerStageElevenSeeder(name: string, seeder: StageElevenSeeder): void {
  seeders.set(name, seeder);
}

export function applyStageElevenSeed(
  seed: StageElevenSeed,
  state: MockState,
  variants: StageElevenVariants = {},
): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const [name, seeder] of seeders) {
    results[name] = seeder(seed, state, variants) ?? null;
  }
  return results;
}

export function stageElevenSeederNames(): string[] {
  return [...seeders.keys()];
}
