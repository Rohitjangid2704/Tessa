import type { MockState } from "../state";

export type StageTenSeed = "default" | "empty";

export type StageTenVariants = Readonly<Record<string, string>>;

export type StageTenSeeder = (
  seed: StageTenSeed,
  state: MockState,
  variants: StageTenVariants,
) => unknown;

const seeders = new Map<string, StageTenSeeder>();

export function registerStageTenSeeder(name: string, seeder: StageTenSeeder): void {
  seeders.set(name, seeder);
}

export function applyStageTenSeed(
  seed: StageTenSeed,
  state: MockState,
  variants: StageTenVariants = {},
): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const [name, seeder] of seeders) {
    results[name] = seeder(seed, state, variants) ?? null;
  }
  return results;
}

export function stageTenSeederNames(): string[] {
  return [...seeders.keys()];
}
