import type { Goal } from "@/lib/api/types";
import { seedGoals } from "./goal-seed";

export type GoalSeed = "default" | "empty";

export class GoalStore {
  private rows: Goal[] = seedGoals();

  reset(seed: GoalSeed = "default"): void {
    this.rows = seed === "empty" ? [] : seedGoals();
  }

  get goals(): readonly Goal[] {
    return this.rows;
  }

  find(id: string): Goal | undefined {
    return this.rows.find((row) => row.id === id);
  }

  titleTaken(targetId: string, title: string, exceptId?: string): boolean {
    const wanted = title.trim().toLowerCase();
    return this.rows.some(
      (row) =>
        row.target_id === targetId && row.id !== exceptId && row.title.trim().toLowerCase() === wanted,
    );
  }

  add(goal: Goal): void {
    this.rows.push(goal);
  }

  replace(updated: Goal): void {
    this.rows = this.rows.map((row) => (row.id === updated.id ? updated : row));
  }

  remove(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length !== before;
  }
}
