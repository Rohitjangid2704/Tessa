import { ADMIN_USER, MEMBER_USER } from "../factories/users";
import { STAGE_ONE_IDS } from "../stage1/seed";
import type { Persona } from "@/lib/api/types";
import { SIMULATOR_IDS } from "./sim-ids";

export function seedPersonas(): Persona[] {
  return [
    {
      id: SIMULATOR_IDS.personas.impatientGuest,
      target_id: STAGE_ONE_IDS.gracie,
      name: "Impatient guest",
      description:
        "A hotel guest in a hurry who types short, sometimes sharp messages and expects an answer in one reply.",
      traits: { tone: "terse", patience: "low", tech_savvy: 2, language: "en" },
      created_by: MEMBER_USER.id,
    },
    {
      id: SIMULATOR_IDS.personas.meticulousManager,
      target_id: STAGE_ONE_IDS.gracie,
      name: "Detail-oriented manager",
      description:
        "A property manager who wants exact figures, asks where an answer comes from and checks every number.",
      traits: { tone: "formal", patience: "high", tech_savvy: 4, asks_for_sources: true },
      created_by: ADMIN_USER.id,
    },
    {
      id: SIMULATOR_IDS.personas.firstTimer,
      target_id: STAGE_ONE_IDS.gracie,
      name: "First-time user",
      description:
        "Someone who has never used the app, writes long hesitant messages and often misspells room names.",
      traits: { tone: "hesitant", patience: "medium", tech_savvy: 1, makes_typos: true },
      created_by: MEMBER_USER.id,
    },
    {
      id: SIMULATOR_IDS.personas.billingAnalyst,
      target_id: STAGE_ONE_IDS.billing,
      name: "Billing analyst",
      description: "An analyst reconciling invoices who asks for totals, dates and tax lines.",
      traits: { tone: "neutral", patience: "high", tech_savvy: 5 },
      created_by: ADMIN_USER.id,
    },
  ];
}
