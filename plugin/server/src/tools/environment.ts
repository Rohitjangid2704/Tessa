import { z } from "zod";
import { unwrap } from "../client";
import { localError } from "../errors";
import type { Schemas } from "../types";
import { defineTool } from "./define";

export function summariseEnvironment(list: Schemas["EnvironmentList"]) {
  return {
    missing_required: list.missing_required,
    variables: list.items.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
      required: variable.required,
      secret: variable.secret,
      has_value: variable.has_value,
      stale: variable.stale,
      purpose: variable.purpose,
      interface_ids: variable.interface_ids,
      health: variable.health,
    })),
  };
}

export const getEnvironment = defineTool({
  name: "get_environment",
  title: "Get environment",
  description:
    "Read. The environment variables a target needs: name, kind, required, secret, has_value, health. Values are never returned.",
  access: "read",
  input: {
    target_id: z.string().uuid(),
  },
  async handler(context, args) {
    const list = await unwrap(
      context.api.client.GET("/api/v1/targets/{target_id}/environment", {
        params: { path: { target_id: args.target_id } },
      }),
    );
    return summariseEnvironment(list);
  },
});

export const setEnvironment = defineTool({
  name: "set_environment",
  title: "Set environment",
  description:
    "Write. Stores explicit name and value pairs in the encrypted Tessa vault for a target, and optionally clears names. Pass only pairs the user confirmed; this tool never reads files. The result lists names only, never values.",
  access: "write",
  idempotent: true,
  destructive: true,
  input: {
    target_id: z.string().uuid(),
    values: z
      .record(z.string().min(1).max(200), z.string().min(1).max(65_536))
      .optional()
      .describe("Variable name to value"),
    clear: z
      .array(z.string().min(1).max(200))
      .max(200)
      .optional()
      .describe("Variable names whose value is removed"),
  },
  async handler(context, args) {
    const values = args.values ?? {};
    const clear = args.clear ?? [];
    if (Object.keys(values).length === 0 && clear.length === 0) {
      throw localError("nothing_to_set", "Pass values, clear, or both");
    }
    for (const value of Object.values(values)) {
      context.redactor.addLiteral(value);
    }
    const list = await unwrap(
      context.api.client.PATCH("/api/v1/targets/{target_id}/environment", {
        params: { path: { target_id: args.target_id } },
        body: { set: values, clear },
      }),
    );
    const summary = summariseEnvironment(list);
    return {
      set: Object.keys(values).sort(),
      cleared: [...clear].sort(),
      missing_required: summary.missing_required,
      missing_required_names: summary.variables
        .filter((variable) => variable.required && !variable.has_value)
        .map((variable) => variable.name),
    };
  },
});

export const runHealthChecks = defineTool({
  name: "run_health_checks",
  title: "Run health checks",
  description:
    "Write. Runs the interface health checks of a target against its stored environment and returns the report: status, latency and message per interface. Optionally limit to interface ids.",
  access: "write",
  idempotent: true,
  input: {
    target_id: z.string().uuid(),
    interface_ids: z.array(z.string().min(1)).max(100).optional(),
  },
  async handler(context, args) {
    const report = await unwrap(
      context.api.client.POST("/api/v1/targets/{target_id}/health-checks", {
        params: { path: { target_id: args.target_id } },
        body: args.interface_ids ? { interface_ids: args.interface_ids } : null,
      }),
    );
    return {
      target_id: report.target_id,
      checked_at: report.checked_at,
      interfaces: report.interfaces.map((entry) => ({
        interface_id: entry.interface_id,
        kind: entry.kind,
        status: entry.status,
        latency_ms: entry.latency_ms ?? null,
        message: entry.message ?? null,
        variables: entry.variables,
      })),
    };
  },
});
