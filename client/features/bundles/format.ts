import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type BundleSourceKind = Schemas["BundleSourceKind"];
export type BundleValidationStatus = Schemas["BundleValidationStatus"];
export type BundleCompletenessStatus = Schemas["BundleCompletenessStatus"];

const SOURCE_LABELS: Record<BundleSourceKind, string> = {
  zip: "Zip upload",
  manifest_paste: "Pasted manifest",
  git: "Git pull",
};

export const SHORT_HASH_LENGTH = 8;

export function describeSource(source: BundleSourceKind): string {
  return SOURCE_LABELS[source];
}

export function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH);
}

export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function describeCompleteness(status: BundleCompletenessStatus): string {
  return status === "meets_bar" ? "Meets the bar" : "Below the bar";
}

export function describeValidation(status: BundleValidationStatus): string {
  return status === "valid" ? "Valid" : "Invalid";
}
