import type { Persona } from "@/lib/api/types";
import { seedPersonas } from "./persona-seed";

export type PersonaSeed = "default" | "empty";

export class PersonaStore {
  private rows: Persona[] = seedPersonas();

  reset(seed: PersonaSeed = "default"): void {
    this.rows = seed === "empty" ? [] : seedPersonas();
  }

  get personas(): readonly Persona[] {
    return this.rows;
  }

  find(id: string): Persona | undefined {
    return this.rows.find((row) => row.id === id);
  }

  nameTaken(targetId: string, name: string, exceptId?: string): boolean {
    const wanted = name.trim().toLowerCase();
    return this.rows.some(
      (row) =>
        row.target_id === targetId && row.id !== exceptId && row.name.trim().toLowerCase() === wanted,
    );
  }

  add(persona: Persona): void {
    this.rows.push(persona);
  }

  replace(updated: Persona): void {
    this.rows = this.rows.map((row) => (row.id === updated.id ? updated : row));
  }

  remove(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    return this.rows.length !== before;
  }
}
