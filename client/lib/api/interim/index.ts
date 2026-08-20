import type { components as GeneratedComponents, paths as GeneratedPaths } from "../schema";
import type { components as Phase5Components, paths as Phase5Paths } from "./phase-5";
import type { components as Phase6Components, paths as Phase6Paths } from "./phase-6";
import type { components as Phase7Components, paths as Phase7Paths } from "./phase-7";
import type { components as Phase8Components, paths as Phase8Paths } from "./phase-8";
import type { components as Phase9Components, paths as Phase9Paths } from "./phase-9";
import type { components as Phase10Components, paths as Phase10Paths } from "./phase-10";
import type { components as Phase11Components, paths as Phase11Paths } from "./phase-11";

type PathMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

type WithMethods<Generated, Interim, Methods extends PathMethod> = Omit<Generated, Methods> &
  Pick<Interim, Methods & keyof Interim>;

type WithRequestBody<Operation, Body> = Omit<Operation, "requestBody"> & {
  requestBody: { content: { "application/json": Body } };
};

type WithMethodRequestBody<Item, Method extends PathMethod, Body> = Omit<Item, Method> & {
  [Key in Method]: WithRequestBody<Item[Key & keyof Item], Body>;
};

export type PromptIssueCreateAny =
  | GeneratedComponents["schemas"]["PromptIssueCreate"]
  | Phase5Components["schemas"]["ExplainPromptParams"]
  | Phase6Components["schemas"]["AuthorPromptParams"]
  | Phase8Components["schemas"]["MutantsPromptParams"]
  | Phase8Components["schemas"]["HooksPromptParams"];

type PlanCreateWithApiFuzz = GeneratedComponents["schemas"]["PlanCreate"] &
  Phase6Components["schemas"]["PlanCreateApiFuzz"];

type TargetUpdateWithTeamFields = GeneratedComponents["schemas"]["TargetUpdate"] &
  Phase10Components["schemas"]["TargetUpdateTeamFields"];

type RunCreateWithSubset = GeneratedComponents["schemas"]["RunCreate"] &
  Phase11Components["schemas"]["RunCreateSubsetFields"];

type ExplanationCreateWithStructured = Phase5Components["schemas"]["ExplanationCreate"] &
  Phase11Components["schemas"]["ExplanationStructuredCreateFields"];

type OverlappingPhase6Keys = "/api/v1/scenarios" | "/api/v1/scenarios/{scenario_id}";

export type InterimPathOverrides = {
  "/api/v1/targets/{target_id}/prompt-issues": WithMethodRequestBody<
    GeneratedPaths["/api/v1/targets/{target_id}/prompt-issues"],
    "post",
    PromptIssueCreateAny
  >;
  "/api/v1/plans": WithMethodRequestBody<
    GeneratedPaths["/api/v1/plans"],
    "post",
    PlanCreateWithApiFuzz
  >;
  "/api/v1/plans/preview": WithMethodRequestBody<
    GeneratedPaths["/api/v1/plans/preview"],
    "post",
    PlanCreateWithApiFuzz
  >;
  "/api/v1/targets/{target_id}": WithMethodRequestBody<
    GeneratedPaths["/api/v1/targets/{target_id}"],
    "patch",
    TargetUpdateWithTeamFields
  >;
  "/api/v1/runs": WithMethodRequestBody<GeneratedPaths["/api/v1/runs"], "post", RunCreateWithSubset>;
  "/api/v1/findings/{finding_id}/explanations": WithMethodRequestBody<
    Phase5Paths["/api/v1/findings/{finding_id}/explanations"],
    "post",
    ExplanationCreateWithStructured
  >;
  "/api/v1/scenarios": WithMethods<
    GeneratedPaths["/api/v1/scenarios"],
    Phase6Paths["/api/v1/scenarios"],
    "post"
  >;
  "/api/v1/scenarios/{scenario_id}": WithMethods<
    GeneratedPaths["/api/v1/scenarios/{scenario_id}"],
    Phase6Paths["/api/v1/scenarios/{scenario_id}"],
    "put" | "patch"
  >;
};

export type InterimPaths = Omit<Phase5Paths, "/api/v1/findings/{finding_id}/explanations"> &
  Omit<Phase6Paths, OverlappingPhase6Keys> &
  Phase7Paths &
  Phase8Paths &
  Phase9Paths &
  Phase10Paths &
  Phase11Paths &
  InterimPathOverrides;

export type InterimSchemas = Phase5Components["schemas"] &
  Phase6Components["schemas"] &
  Phase7Components["schemas"] &
  Phase8Components["schemas"] &
  Phase9Components["schemas"] &
  Phase10Components["schemas"] &
  Phase11Components["schemas"];

export type MergedPaths = Omit<GeneratedPaths, keyof InterimPaths> & InterimPaths;
