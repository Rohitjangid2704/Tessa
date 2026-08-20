import type { Route } from "next";
import { safeCallbackPath } from "@/lib/auth/safe-redirect";

export const routes = {
  home: "/",
  login: "/login",
  targets: "/targets",
  catalog: "/catalog",
  coverage: "/coverage",
  scenarios: "/scenarios",
  runs: "/runs",
  findings: "/findings",
  labels: "/labels",
  seeds: "/seeds",
  oracle: "/oracle",
  explore: "/explore",
  simulators: "/simulators",
  redteam: "/redteam",
  replay: "/replay",
  mutation: "/mutation",
  contracts: "/contracts",
  library: "/library",
  runGroups: "/run-groups",
  settings: "/settings",
  devHello: "/dev/hello",
  apiToken: "/api/session/api-token",
} as const;

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export function toRoute(path: string): Route {
  return path as Route;
}

export function withQuery(path: string, query: QueryParams = {}): Route {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  const queryString = search.toString();
  return (queryString ? `${path}?${queryString}` : path) as Route;
}

export const targetRoutes = {
  list: (): Route => toRoute(routes.targets),
  create: (): Route => toRoute(`${routes.targets}/new`),
  detail: (targetId: string): Route => toRoute(`${routes.targets}/${targetId}`),
  bundles: (targetId: string): Route => toRoute(`${routes.targets}/${targetId}/bundles`),
  bundle: (targetId: string, bundleId: string): Route =>
    toRoute(`${routes.targets}/${targetId}/bundles/${bundleId}`),
  environment: (targetId: string): Route => toRoute(`${routes.targets}/${targetId}/environment`),
  proposal: (targetId: string): Route => toRoute(`${routes.targets}/${targetId}/proposal`),
  catalog: (targetId: string): Route => withQuery(routes.catalog, { target_id: targetId }),
} as const;

export const runRoutes = {
  list: (filters: QueryParams = {}): Route => withQuery(routes.runs, filters),
  detail: (runId: string): Route => toRoute(`${routes.runs}/${runId}`),
  step: (runId: string, stepId: string): Route =>
    toRoute(`${routes.runs}/${runId}/steps/${stepId}`),
  tab: (runId: string, tab: RunDetailTab): Route => withQuery(`${routes.runs}/${runId}`, { tab }),
  diff: (runId: string, against?: string | null): Route =>
    withQuery(`${routes.runs}/${runId}/diff`, { against }),
  trends: (filters: QueryParams = {}): Route =>
    withQuery(routes.runs, { ...filters, tab: "trends" }),
} as const;

export type RunDetailTab = "live" | "scenarios" | "results";

export const scenarioRoutes = {
  list: (filters: QueryParams = {}): Route => withQuery(routes.scenarios, filters),
  detail: (scenarioId: string): Route => toRoute(`${routes.scenarios}/${scenarioId}`),
  review: (filters: QueryParams = {}): Route => withQuery(`${routes.scenarios}/review`, filters),
} as const;

export const coverageRoutes = {
  map: (targetId?: string | null, filters: QueryParams = {}): Route =>
    withQuery(routes.coverage, { ...filters, target_id: targetId }),
} as const;

export type SimulatorTab = "personas" | "goals" | "simulations";

export const exploreRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.explore, { target_id: targetId }),
} as const;

export const simulatorRoutes = {
  list: (targetId?: string | null, tab?: SimulatorTab): Route =>
    withQuery(routes.simulators, { target_id: targetId, tab }),
  session: (simSessionId: string, targetId?: string | null): Route =>
    withQuery(routes.simulators, {
      target_id: targetId,
      tab: "simulations",
      session: simSessionId,
    }),
} as const;

export const redteamRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.redteam, { target_id: targetId }),
} as const;

export const replayRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.replay, { target_id: targetId }),
  detail: (replayId: string): Route => withQuery(routes.replay, { replay_id: replayId }),
  cases: (replayId: string): Route => scenarioRoutes.review({ replay_id: replayId }),
} as const;

export function scenarioHref(scenarioId: string): Route {
  return scenarioRoutes.detail(scenarioId);
}

export const findingRoutes = {
  list: (filters: QueryParams = {}): Route => withQuery(routes.findings, filters),
  sheet: (findingId: string, filters: QueryParams = {}): Route =>
    withQuery(routes.findings, { ...filters, finding: findingId }),
  detail: (findingId: string): Route => toRoute(`${routes.findings}/${findingId}`),
} as const;

export const seedRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.seeds, { target_id: targetId }),
} as const;

export const oracleRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.oracle, { target_id: targetId }),
  template: (targetId: string, templateId: string): Route =>
    withQuery(routes.oracle, { target_id: targetId, template_id: templateId }),
} as const;

export type LabelTab = "calibration" | "export";

export const labelRoutes = {
  queue: (filters: QueryParams = {}): Route => withQuery(routes.labels, filters),
  tab: (tab: LabelTab, filters: QueryParams = {}): Route =>
    withQuery(routes.labels, { ...filters, tab }),
} as const;

export const mutationRoutes = {
  list: (targetId?: string | null): Route => withQuery(routes.mutation, { target_id: targetId }),
} as const;

export const contractRoutes = {
  list: (filters: QueryParams = {}): Route => withQuery(routes.contracts, filters),
  detail: (contractCheckId: string): Route => toRoute(`${routes.contracts}/${contractCheckId}`),
} as const;

export const libraryRoutes = {
  list: (filters: QueryParams = {}): Route => withQuery(routes.library, filters),
} as const;

export const runGroupRoutes = {
  detail: (runGroupId: string): Route => toRoute(`${routes.runGroups}/${runGroupId}`),
} as const;

export const catalogRoutes = {
  plans: (targetId: string): Route =>
    withQuery(routes.catalog, { target_id: targetId, tab: "plans" }),
  plan: (targetId: string, planId: string): Route =>
    withQuery(routes.catalog, { target_id: targetId, plan: planId }),
} as const;

export const settingsRoutes = {
  root: (): Route => toRoute(routes.settings),
  notifications: (): Route => toRoute(`${routes.settings}/notifications`),
  schedules: (): Route => toRoute(`${routes.settings}/schedules`),
  users: (): Route => toRoute(`${routes.settings}/users`),
  retention: (): Route => toRoute(`${routes.settings}/retention`),
  teams: (): Route => toRoute(`${routes.settings}/teams`),
  tokens: (): Route => toRoute(`${routes.settings}/tokens`),
  activity: (): Route => toRoute(`${routes.settings}/activity`),
} as const;

export function loginPath(callbackUrl?: string | null): string {
  const target = safeCallbackPath(callbackUrl, "");
  if (!target || target === routes.home) {
    return routes.login;
  }
  return `${routes.login}?${new URLSearchParams({ callbackUrl: target }).toString()}`;
}

export function loginHref(callbackUrl?: string | null): Route {
  return loginPath(callbackUrl) as Route;
}
