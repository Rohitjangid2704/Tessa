export const TARGET_SCOPED_PARAMS: ReadonlySet<string> = new Set([
  "plan_id",
  "run_id",
  "finding",
  "template_id",
  "result_id",
  "seed_id",
  "session",
  "replay_id",
  "scenario",
  "bundle_id",
  "against",
  "cell_id",
  "area",
  "role",
  "interface_id",
  "feature_id",
  "family",
]);

export function isTargetScopedParam(name: string): boolean {
  return TARGET_SCOPED_PARAMS.has(name);
}
