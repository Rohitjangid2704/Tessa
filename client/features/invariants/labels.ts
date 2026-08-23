import type { InvariantCheck, InvariantPack } from "@/lib/api/types";

export const INVARIANT_PACKS = [
  "generic",
  "llm_app",
  "target",
] as const satisfies readonly InvariantPack[];

export const INVARIANT_PACK_LABELS = {
  generic: "Generic",
  llm_app: "LLM app",
  target: "This target",
} as const satisfies Record<InvariantPack, string>;

export const INVARIANT_CHECK_LABELS = {
  code: "Code check",
  probe: "Laya probe",
  oracle: "Oracle",
  db: "Database check",
} as const satisfies Record<InvariantCheck, string>;
