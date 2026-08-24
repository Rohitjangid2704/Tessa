import type { Catalog } from "@/features/catalog/types";
import { hydrateBuilderState } from "./plan-selection";
import { clampAttempts } from "./schemas";
import type { Depth, InterfaceMode, Plan } from "./types";

export const DEFAULT_DEPTH: Depth = "smoke";
export const DEFAULT_ATTEMPTS = 1;

export interface LoadedPlan {
  id: string;
  name: string | null;
}

export interface PlanBuilderState {
  featureIds: ReadonlySet<string>;
  roleIds: readonly string[];
  interfaceMode: InterfaceMode | null;
  depth: Depth;
  k: number;
  maxUsd: string;
  maxMinutes: string;
  resetSeed: boolean;
  includeApiFuzz: boolean;
  loadedPlan: LoadedPlan | null;
  notices: readonly string[];
}

export function createInitialBuilderState(): PlanBuilderState {
  return {
    featureIds: new Set<string>(),
    roleIds: [],
    interfaceMode: null,
    depth: DEFAULT_DEPTH,
    k: DEFAULT_ATTEMPTS,
    maxUsd: "",
    maxMinutes: "",
    resetSeed: false,
    includeApiFuzz: false,
    loadedPlan: null,
    notices: [],
  };
}

export type PlanBuilderAction =
  | { type: "toggle_feature"; featureId: string; selected: boolean }
  | { type: "toggle_area"; featureIds: readonly string[]; selected: boolean }
  | { type: "clear_selection" }
  | { type: "set_roles"; roleIds: readonly string[] }
  | { type: "set_interface_mode"; mode: InterfaceMode }
  | { type: "set_depth"; depth: Depth }
  | { type: "set_attempts"; k: number }
  | { type: "set_max_usd"; value: string }
  | { type: "set_max_minutes"; value: string }
  | { type: "set_reset_seed"; value: boolean }
  | { type: "set_api_fuzz"; value: boolean }
  | { type: "load_plan"; plan: Plan; catalog: Catalog }
  | { type: "link_plan"; plan: LoadedPlan }
  | { type: "dismiss_notices" }
  | { type: "reset" };

function withFeatures(
  state: PlanBuilderState,
  featureIds: readonly string[],
  selected: boolean,
): PlanBuilderState {
  const next = new Set(state.featureIds);
  let changed = false;
  for (const featureId of featureIds) {
    if (selected && !next.has(featureId)) {
      next.add(featureId);
      changed = true;
    } else if (!selected && next.has(featureId)) {
      next.delete(featureId);
      changed = true;
    }
  }
  return changed ? { ...state, featureIds: next } : state;
}

export function planBuilderReducer(
  state: PlanBuilderState,
  action: PlanBuilderAction,
): PlanBuilderState {
  switch (action.type) {
    case "toggle_feature":
      return withFeatures(state, [action.featureId], action.selected);
    case "toggle_area":
      return withFeatures(state, action.featureIds, action.selected);
    case "clear_selection":
      return state.featureIds.size === 0 ? state : { ...state, featureIds: new Set<string>() };
    case "set_roles":
      return { ...state, roleIds: [...action.roleIds] };
    case "set_interface_mode":
      return { ...state, interfaceMode: action.mode };
    case "set_depth":
      return { ...state, depth: action.depth };
    case "set_attempts":
      return { ...state, k: clampAttempts(action.k) };
    case "set_max_usd":
      return { ...state, maxUsd: action.value };
    case "set_max_minutes":
      return { ...state, maxMinutes: action.value };
    case "set_reset_seed":
      return { ...state, resetSeed: action.value };
    case "set_api_fuzz":
      return { ...state, includeApiFuzz: action.value };
    case "load_plan":
      return hydrateBuilderState(action.plan, action.catalog, state).state;
    case "link_plan":
      return { ...state, loadedPlan: action.plan };
    case "dismiss_notices":
      return state.notices.length === 0 ? state : { ...state, notices: [] };
    case "reset":
      return createInitialBuilderState();
  }
}
