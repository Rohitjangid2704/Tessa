import { http } from "msw";
import { buildEnvironmentList } from "../factories/environment";
import { conflict, validationFailed } from "../factories/errors";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { knownInterfaceIds, runHealthChecks } from "../stage1/health";
import type { EnvironmentEntry } from "../stage1/store";
import { pathUuid, requireActiveTarget, requireTarget, stageOne } from "../stage1/support";
import { toEnvironmentVariable } from "../stage1/views";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const NAME_MAX_LENGTH = 200;
const VALUE_MAX_LENGTH = 65_536;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listBody(entries: readonly EnvironmentEntry[]) {
  const ordered = [...entries].sort((left, right) => {
    if (left.stale !== right.stale) {
      return left.stale ? 1 : -1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const variables = ordered.map(toEnvironmentVariable);
  const missing = variables.filter(
    (variable) => variable.required && !variable.stale && !variable.has_value,
  ).length;
  return buildEnvironmentList(variables, { missing_required: missing });
}

async function readEnvironment(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  return jsonResponse(listBody(stageOne(context).environmentOf(target.id)));
}

interface ParsedPatch {
  set: Array<[string, string]>;
  clear: string[];
}

function parsePatch(raw: Record<string, unknown>): ParsedPatch {
  const details: ErrorDetail[] = [];
  const reader = new BodyReader(raw);
  const set: Array<[string, string]> = [];
  const rawSet = reader.object("set", {});
  for (const [name, value] of Object.entries(rawSet ?? {})) {
    if (name.length > NAME_MAX_LENGTH) {
      details.push({
        loc: ["body", "set", name],
        code: "string_too_long",
        message: `String should have at most ${NAME_MAX_LENGTH} characters`,
      });
    } else if (typeof value !== "string") {
      details.push({
        loc: ["body", "set", name],
        code: "string_type",
        message: "Input should be a valid string",
      });
    } else if (value.length < 1) {
      details.push({
        loc: ["body", "set", name],
        code: "string_too_short",
        message: "String should have at least 1 character",
      });
    } else if (value.length > VALUE_MAX_LENGTH) {
      details.push({
        loc: ["body", "set", name],
        code: "string_too_long",
        message: `String should have at most ${VALUE_MAX_LENGTH} characters`,
      });
    } else {
      set.push([name, value]);
    }
  }
  const clear = reader.stringList("clear", {}) ?? [];
  clear.forEach((name, index) => {
    if (name.length > NAME_MAX_LENGTH) {
      details.push({
        loc: ["body", "clear", index],
        code: "string_too_long",
        message: `String should have at most ${NAME_MAX_LENGTH} characters`,
      });
    }
  });
  const all = [...reader.details, ...details];
  if (all.length > 0) {
    throw validationFailed(all);
  }
  return { set, clear: [...new Set(clear)] };
}

function valueProblem(entry: EnvironmentEntry, value: string): [string, string] | null {
  if (entry.kind === "url" || entry.kind === "dsn") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(value.trim());
    } catch {
      parsed = null;
    }
    const hasHost = parsed !== null && parsed.host !== "";
    if (parsed === null || !hasHost) {
      return ["invalid_value", `A ${entry.kind} variable needs a value like scheme://host`];
    }
    if (entry.kind === "url" && !entry.secret && (parsed.username || parsed.password)) {
      return [
        "url_with_userinfo_not_allowed",
        "A URL that carries a username or password cannot be stored as a plain variable",
      ];
    }
  }
  if (entry.kind === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
    return ["invalid_value", "A number variable needs a finite number"];
  }
  if (entry.kind === "bool" && !["true", "false"].includes(value.trim().toLowerCase())) {
    return ["invalid_value", "A bool variable needs true or false"];
  }
  return null;
}

function normalise(entry: EnvironmentEntry, value: string): string {
  if (entry.kind === "bool") {
    return value.trim().toLowerCase();
  }
  return ["url", "dsn", "number"].includes(entry.kind) ? value.trim() : value;
}

async function patchEnvironment(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const patch = parsePatch(parseJsonObject(await context.request.text()));
  const target = requireActiveTarget(context, targetId);
  const entries = stageOne(context).environmentOf(target.id);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const problems: ErrorDetail[] = [];
  for (const [name, value] of patch.set) {
    const entry = byName.get(name);
    if (entry === undefined) {
      problems.push({
        loc: ["body", "set", name],
        code: "unknown_variable",
        message: "The target does not declare this variable",
      });
    } else if (patch.clear.includes(name)) {
      problems.push({
        loc: ["body", "set", name],
        code: "conflicting_operation",
        message: "The variable is both set and cleared",
      });
    } else {
      const problem = valueProblem(entry, value);
      if (problem !== null) {
        problems.push({ loc: ["body", "set", name], code: problem[0], message: problem[1] });
      }
    }
  }
  patch.clear.forEach((name, index) => {
    if (!byName.has(name)) {
      problems.push({
        loc: ["body", "clear", index],
        code: "unknown_variable",
        message: "The target does not declare this variable",
      });
    }
  });
  if (problems.length > 0) {
    throw validationFailed(problems);
  }
  const now = nowIso();
  const touch = (entry: EnvironmentEntry, value: string | null) => {
    entry.value = value;
    entry.last_set_at = now;
    entry.last_set_by = user.id;
    entry.health = { status: "unchecked", checked_at: null, latency_ms: null, message: null };
  };
  for (const [name, value] of patch.set) {
    const entry = byName.get(name);
    if (entry !== undefined) {
      touch(entry, normalise(entry, value));
    }
  }
  for (const name of patch.clear) {
    const entry = byName.get(name);
    if (entry !== undefined) {
      touch(entry, null);
    }
  }
  return jsonResponse(listBody(entries));
}

function parseHealthBody(text: string): string[] | null {
  if (text.trim() === "") {
    return null;
  }
  const reader = new BodyReader(parseJsonObject(text));
  const ids = reader.stringList("interface_ids", { nullable: true });
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return ids ?? null;
}

async function createHealthCheck(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const targetId = pathUuid(context, "target_id");
  const wanted = parseHealthBody(await context.request.text());
  const target = requireActiveTarget(context, targetId);
  const store = stageOne(context);
  const record = store.latestValidBundle(target.id);
  if (record === undefined) {
    throw conflict("target_not_ready", "Upload a valid bundle before running health checks");
  }
  const known = knownInterfaceIds(record);
  if (wanted !== null) {
    const unknown: ErrorDetail[] = wanted.flatMap((id, index) =>
      known.includes(id)
        ? []
        : [
            {
              loc: ["body", "interface_ids", index],
              code: "unknown_interface",
              message: "The latest valid bundle declares no such interface",
            },
          ],
    );
    if (unknown.length > 0) {
      throw validationFailed(unknown);
    }
  }
  if (context.state.faults.healthSlowMs > 0) {
    await sleep(context.state.faults.healthSlowMs);
  }
  const report = runHealthChecks({
    record,
    environment: store.environmentOf(target.id),
    previous: target.healthReport,
    targetId: target.id,
    selected: wanted === null ? null : new Set(wanted),
    checkedAt: nowIso(),
  });
  target.healthReport = report;
  return jsonResponse(report);
}

async function readHealth(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const target = requireTarget(context, pathUuid(context, "target_id"));
  return jsonResponse(
    target.healthReport ?? { target_id: target.id, checked_at: null, interfaces: [] },
  );
}

export const environmentHandlers = [
  http.get("*/api/v1/targets/:target_id/environment", api(readEnvironment)),
  http.patch("*/api/v1/targets/:target_id/environment", api(patchEnvironment)),
  http.post("*/api/v1/targets/:target_id/health-checks", api(createHealthCheck)),
  http.get("*/api/v1/targets/:target_id/health", api(readHealth)),
];
