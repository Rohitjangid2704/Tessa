import type { components } from "@/lib/api/schema";

export type LimitsRead = components["schemas"]["LimitsRead"];

export const DEFAULT_BUNDLE_MAX_ZIP_BYTES = 26_214_400;
export const DEFAULT_BUNDLE_MAX_MANIFEST_BYTES = 1_048_576;
export const DEFAULT_EXPLANATION_MAX_CHARS = 20_000;
export const DEFAULT_REPLAY_MAX_BYTES = 52_428_800;

export function buildLimits(overrides: Partial<LimitsRead> = {}): LimitsRead {
  return {
    bundle_max_zip_bytes: DEFAULT_BUNDLE_MAX_ZIP_BYTES,
    bundle_max_manifest_bytes: DEFAULT_BUNDLE_MAX_MANIFEST_BYTES,
    replay_max_bytes: DEFAULT_REPLAY_MAX_BYTES,
    explanation_max_chars: DEFAULT_EXPLANATION_MAX_CHARS,
    ...overrides,
  };
}
