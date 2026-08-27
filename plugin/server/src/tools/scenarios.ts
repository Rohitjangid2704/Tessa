import { z } from "zod";
import { unwrap } from "../client";
import { cutList } from "../cut";
import { localError } from "../errors";
import { asList } from "./args";
import { defineTool } from "./define";

const SCENARIO_STATUSES = [
  "draft",
  "validating",
  "invalid",
  "in_review",
  "accepted",
  "rejected",
  "quarantined",
  "retired",
] as const;
const ISSUE_LIMIT = 50;
const MAX_SCENARIO_YAML_BYTES = 262_144;

export const validateScenario = defineTool({
  name: "validate_scenario",
  title: "Validate scenario",
  description:
    "Read (nothing is saved). Checks one scenario document against the scenario schema, the closed vocabulary of the target's latest bundle and the lints. Returns valid, errors and warnings with code, pointer, line and message. Pass the YAML text; the target defaults to the one selected with get_target.",
  access: "read",
  idempotent: true,
  input: {
    yaml: z.string().min(1).describe("The scenario YAML text"),
    target_id: z.string().uuid().optional().describe("Defaults to the target selected with get_target"),
  },
  async handler(context, args) {
    const targetId = args.target_id ?? context.session.state.targetId;
    if (targetId === undefined) {
      throw localError("target_required", "Pass target_id or call get_target first so the session has a target");
    }
    if (Buffer.byteLength(args.yaml) > MAX_SCENARIO_YAML_BYTES) {
      throw localError("scenario_too_large", `The scenario is larger than ${MAX_SCENARIO_YAML_BYTES} bytes`);
    }
    const result = await unwrap(
      context.api.client.POST("/api/v1/scenarios/validate", {
        body: { target_id: targetId, yaml: args.yaml },
      }),
    );
    const errors = cutList(result.errors, ISSUE_LIMIT);
    const warnings = cutList(result.warnings, ISSUE_LIMIT);
    return {
      valid: result.valid,
      errors: errors.items,
      errors_total: errors.total,
      warnings: warnings.items,
      warnings_total: warnings.total,
      truncated: errors.truncated || warnings.truncated,
    };
  },
});

export const listScenarios = defineTool({
  name: "list_scenarios",
  title: "List scenarios",
  description:
    "Read. Lists the scenarios of a target, newest first: id, title, status (in_review means a person has not accepted it yet), origin, feature, family, cell, version and the validation outcome. Synthetic scenarios are left out. Filter by status. Scenario ids are what start_run takes for a subset run.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
    status: z.union([z.enum(SCENARIO_STATUSES), z.array(z.enum(SCENARIO_STATUSES)).min(1)]).optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Page size, default 50"),
  },
  async handler(context, args) {
    const page = await unwrap(
      context.api.client.GET("/api/v1/scenarios", {
        params: {
          query: {
            target_id: args.target_id,
            status: asList(args.status),
            limit: args.limit ?? 50,
          },
        },
      }),
    );
    return {
      scenarios: page.items.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        status: scenario.status,
        origin: scenario.origin,
        feature_id: scenario.feature_id,
        family: scenario.family,
        cell_id: scenario.cell_id,
        version: scenario.version,
        bundle_id: scenario.bundle_id,
        valid: scenario.validation.valid,
        error_count: scenario.validation.errors.length,
        warning_count: scenario.validation.warnings.length,
        first_error: scenario.validation.errors[0]?.message ?? null,
        updated_at: scenario.updated_at,
      })),
      has_more: page.next_cursor !== null,
    };
  },
});
