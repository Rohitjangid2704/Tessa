export type StageSevenSeed = "default" | "empty";

export type StageSevenSeeder = (seed: StageSevenSeed) => void;

const seeders = new Map<string, StageSevenSeeder>();

export function registerStageSevenSeeder(name: string, seeder: StageSevenSeeder): void {
  seeders.set(name, seeder);
}

export function applyStageSevenSeed(seed: StageSevenSeed): string[] {
  const applied: string[] = [];
  for (const [name, seeder] of seeders) {
    seeder(seed);
    applied.push(name);
  }
  return applied;
}

export function stageSevenSeederNames(): string[] {
  return [...seeders.keys()];
}
