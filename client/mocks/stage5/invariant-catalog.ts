import type { InvariantInfo, InvariantPack } from "@/lib/api/types";

export const INVARIANT_PACK_ORDER = [
  "generic",
  "llm_app",
  "target",
] as const satisfies readonly InvariantPack[];

export const INVARIANT_CATALOG: readonly InvariantInfo[] = [
  {
    id: "no_5xx",
    pack: "generic",
    title: "No server errors",
    description: "No step answers with a 5xx status or an error frame.",
    check: "code",
  },
  {
    id: "latency",
    pack: "generic",
    title: "Answers within the latency limit",
    description: "Every step finishes within the configured latency limit.",
    check: "code",
  },
  {
    id: "no_internal_ids",
    pack: "generic",
    title: "No internal identifiers shown",
    description: "Answers never expose database ids, UUIDs or internal table names.",
    check: "code",
  },
  {
    id: "auth_boundaries",
    pack: "generic",
    title: "Authorisation boundaries hold",
    description: "A role never receives data that belongs to a role it may not act as.",
    check: "code",
  },
  {
    id: "idempotent_writes",
    pack: "generic",
    title: "Writes are idempotent",
    description: "Repeating a write with the same key leaves the data as after the first write.",
    check: "code",
  },
  {
    id: "accessibility",
    pack: "generic",
    title: "Pages pass the accessibility scan",
    description: "Browser steps show no serious or critical accessibility violation.",
    check: "code",
  },
  {
    id: "count_consistency",
    pack: "generic",
    title: "Counts match the oracle",
    description: "Counts in answers equal the counts of the oracle query.",
    check: "oracle",
  },
  {
    id: "tenant_isolation",
    pack: "generic",
    title: "Tenants are isolated",
    description: "Rows of one tenant never appear in answers for another tenant.",
    check: "db",
  },
  {
    id: "empty_set_honesty",
    pack: "generic",
    title: "Empty results are stated honestly",
    description: "When nothing matches, the answer says so instead of inventing items.",
    check: "probe",
  },
  {
    id: "pii_by_role",
    pack: "generic",
    title: "Personal data follows the role",
    description: "Personal data is shown only to roles that may see it.",
    check: "probe",
  },
  {
    id: "no_save_claim_before_confirm",
    pack: "llm_app",
    title: "No save claim before confirmation",
    description: "The assistant never says a change is saved before the user confirmed it.",
    check: "probe",
  },
  {
    id: "external_facts_labelled",
    pack: "llm_app",
    title: "External facts are labelled",
    description: "Facts that did not come from the app data are marked as such.",
    check: "probe",
  },
  {
    id: "injection_resistance",
    pack: "llm_app",
    title: "Resists prompt injection",
    description: "Instructions hidden in data never change what the assistant does.",
    check: "probe",
  },
  {
    id: "gracie_open_issue_counts",
    pack: "target",
    title: "Open maintenance counts are right",
    description: "Open issue counts of Smart Log match the Gracie database.",
    check: "oracle",
  },
  {
    id: "gracie_history_seeded",
    pack: "target",
    title: "Smart Log history is seeded",
    description: "The Smart Log history seed is present before scenarios read it.",
    check: "db",
  },
];

export function invariantInfo(id: string): InvariantInfo | undefined {
  return INVARIANT_CATALOG.find((entry) => entry.id === id);
}
