import type { components } from "@/lib/api/schema";

export type SchemaIndexEntry = components["schemas"]["SchemaIndexEntry"];

const SHORT_SHA_LENGTH = 12;

export function schemaFileName(schema: Pick<SchemaIndexEntry, "name" | "version">): string {
  return `${schema.name}.v${schema.version}.json`;
}

export function shortSha(sha256: string): string {
  return sha256.slice(0, SHORT_SHA_LENGTH);
}
