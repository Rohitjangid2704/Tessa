import type { BundleUploadResult } from "../factories/bundles";
import { newId } from "../factories/ids";
import { nowIso } from "../stage2/support";
import type { MockState } from "../state";
import { ensureMutationSeed } from "./mutation-seed";
import { mutationStore } from "./mutation-store";

export const MUTANTS_IMPORT_MARKER = "mutants";

const MUTANTS_FILE = "tessa/mutants.yaml";

type ImportWarning = BundleUploadResult["bundle"]["warnings"][number];

interface ImportedMutant {
  name: string;
  description: string;
  expectedCatchers: readonly string[];
}

const IMPORTED_MUTANTS: readonly ImportedMutant[] = [
  {
    name: "skip-auth-check-on-export",
    description: "The export route no longer checks the role of the caller.",
    expectedCatchers: ["auth_boundaries"],
  },
  {
    name: "return-unmasked-email-to-viewer",
    description: "The viewer role receives guest email addresses without masking.",
    expectedCatchers: ["pii_by_role"],
  },
  {
    name: "ignore-idempotency-key-on-create",
    description: "Creating a request twice with the same Idempotency-Key makes two requests.",
    expectedCatchers: ["idempotent_writes"],
  },
];

const SKIPPED_ENTRY_WARNING: ImportWarning = {
  code: "mutant_unknown_invariant",
  file: MUTANTS_FILE,
  message:
    "entry 4 names the invariant tenant_leak in expected_catchers, which does not exist; the entry was skipped",
  pointer: "/3/expected_catchers/0",
  line: 31,
  column: 7,
  severity: "warning",
};

export function isMutantsImportName(fileName: string): boolean {
  return fileName.toLowerCase().includes(MUTANTS_IMPORT_MARKER);
}

export function applyMutantsImport(
  state: MockState,
  accepted: { status: number; body: BundleUploadResult },
): { status: number; body: BundleUploadResult } {
  const { bundle, created } = accepted.body;
  if (!created || bundle.validation_status !== "valid") {
    return accepted;
  }
  ensureMutationSeed(state);
  const known = new Set(
    mutationStore.mutantsOf(bundle.target_id).map((mutant) => mutant.name.toLowerCase()),
  );
  let imported = 0;
  for (const entry of IMPORTED_MUTANTS) {
    if (known.has(entry.name)) {
      continue;
    }
    mutationStore.addMutant({
      id: newId(),
      target_id: bundle.target_id,
      name: entry.name,
      branch: `mutant/${entry.name}`,
      description: entry.description,
      expected_catchers: [...entry.expectedCatchers],
      base_url: null,
      status: "registered",
      last_outcome: null,
      created_at: nowIso(),
    });
    imported += 1;
  }
  bundle.mutants_imported = imported;
  bundle.warnings = [...bundle.warnings, SKIPPED_ENTRY_WARNING];
  return accepted;
}
