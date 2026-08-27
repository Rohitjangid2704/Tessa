import { hookOutput, runHook, runtimeAdvisory } from "./hook-common.mjs";

const LOADED = "Tessa plugin loaded; run /tessa:connect to pick a target.";
const NEEDS_TOKEN = "Tessa plugin needs its token: run /plugin to configure it.";

await runHook(async (_input, env) => {
  const token = (env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? "").trim();
  const state = token.length === 0 ? NEEDS_TOKEN : LOADED;
  const advisory = runtimeAdvisory(process.version, process.platform);
  return hookOutput("SessionStart", advisory === null ? state : `${state} ${advisory}`);
});
