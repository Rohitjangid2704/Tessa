import { LineCounter, parseDocument } from "yaml";
import type { BundleRecord } from "../stage1/store";
import type { ScenarioIssue, ScenarioValidation } from "@/lib/api/types";

type JsonRecord = Record<string, unknown>;

export const CANNED_BAD_SCENARIO_YAML = `schema_version: 1
title: Staff login rejects a wrong password
family: account-access
role: guest
interface_id: rest_api
steps:
  - adapter: http
    request:
      method: POST
      path: auth/login
    expect:
      status: 401
`;

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "id",
  "title",
  "feature_id",
  "family",
  "role",
  "interface_id",
  "timeout_seconds",
  "cell",
  "authored_from",
  "synthetic",
  "steps",
]);

const REQUIRED_KEYS = ["schema_version", "title", "family", "role", "interface_id", "steps"];
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const PATH_PATTERN = /^\/([^/\s]\S*)?$/;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const ADAPTERS = ["http", "sse", "browser"];
const BROWSER_ACTIONS = ["goto", "click", "fill", "press", "select", "check", "hover", "wait_for"];
const ACTIONS_NEEDING_TARGET = ["click", "fill", "select", "check", "hover"];
const TITLE_MAX = 200;
const STEPS_MAX = 200;
const TIMEOUT_MAX_SECONDS = 3600;
const FIRST_LINE = /\r?\n/;

export interface ScenarioCheck {
  validation: ScenarioValidation;
  doc: JsonRecord | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, pointer: string, message: string): ScenarioIssue {
  return { code, pointer, line: null, column: null, message };
}

function checkRoot(doc: JsonRecord, record: BundleRecord | undefined): {
  errors: ScenarioIssue[];
  warnings: ScenarioIssue[];
} {
  const errors: ScenarioIssue[] = [];
  const warnings: ScenarioIssue[] = [];

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(issue("unknown_key", `/${key}`, `${key} is not a known scenario field`));
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (doc[key] === undefined || doc[key] === null) {
      errors.push(issue("missing", `/${key}`, `${key} is required`));
    }
  }
  if (doc.schema_version !== undefined && doc.schema_version !== 1) {
    errors.push(
      issue("schema_version_unsupported", "/schema_version", "schema_version must be 1"),
    );
  }
  const { title, family, role } = doc;
  if (typeof title === "string" && (title.trim() === "" || title.length > TITLE_MAX)) {
    errors.push(issue("string_length", "/title", `title must have 1 to ${TITLE_MAX} characters`));
  } else if (title !== undefined && title !== null && typeof title !== "string") {
    errors.push(issue("string_type", "/title", "title must be a string"));
  }
  if (typeof family === "string" && !IDENTIFIER_PATTERN.test(family)) {
    errors.push(
      issue("pattern_mismatch", "/family", "family must be a slug such as smart-log"),
    );
  }
  if (typeof role === "string" && record !== undefined) {
    if (!record.roles.some((entry) => entry.id === role)) {
      errors.push(issue("unknown_role", "/role", `role ${role} is not declared in the bundle`));
    }
  }
  const interfaceId = doc.interface_id;
  if (typeof interfaceId === "string" && record !== undefined) {
    if (!record.interfaces.some((entry) => entry.id === interfaceId)) {
      errors.push(
        issue(
          "unknown_interface",
          "/interface_id",
          `interface ${interfaceId} is not declared in the bundle`,
        ),
      );
    }
  }
  const featureId = doc.feature_id;
  if (typeof featureId === "string" && record !== undefined) {
    if (!record.features.some((entry) => entry.feature_id === featureId)) {
      warnings.push(
        issue("unknown_feature", "/feature_id", `feature ${featureId} is not in this bundle version`),
      );
    }
  }
  const timeout = doc.timeout_seconds;
  const timeoutInRange =
    typeof timeout === "number" &&
    Number.isInteger(timeout) &&
    timeout >= 1 &&
    timeout <= TIMEOUT_MAX_SECONDS;
  if (timeout !== undefined && timeout !== null && !timeoutInRange) {
    errors.push(
      issue(
        "out_of_range",
        "/timeout_seconds",
        `timeout_seconds must be a whole number from 1 to ${TIMEOUT_MAX_SECONDS}`,
      ),
    );
  }
  const { cell } = doc;
  if (isRecord(cell) && (cell.role !== role || cell.interface_id !== interfaceId)) {
    errors.push(issue("cell_mismatch", "/cell", "cell must equal role and interface_id"));
  }
  return { errors, warnings };
}

function checkRequestStep(step: JsonRecord, base: string, errors: ScenarioIssue[]): void {
  const request = step.request;
  if (!isRecord(request)) {
    errors.push(issue("missing", `${base}/request`, "request is required for this step"));
    return;
  }
  if (typeof request.method !== "string" || !HTTP_METHODS.includes(request.method)) {
    errors.push(
      issue("enum", `${base}/request/method`, `method must be one of ${HTTP_METHODS.join(", ")}`),
    );
  }
  if (typeof request.path !== "string") {
    errors.push(issue("missing", `${base}/request/path`, "path is required"));
  } else if (!PATH_PATTERN.test(request.path)) {
    errors.push(
      issue(
        "path_not_absolute",
        `${base}/request/path`,
        "path must start with / and contain no spaces",
      ),
    );
  }
}

function checkBrowserStep(step: JsonRecord, base: string, errors: ScenarioIssue[]): void {
  const action = step.action;
  if (typeof action !== "string" || !BROWSER_ACTIONS.includes(action)) {
    errors.push(
      issue("enum", `${base}/action`, `action must be one of ${BROWSER_ACTIONS.join(", ")}`),
    );
    return;
  }
  if (action === "goto" && typeof step.url !== "string") {
    errors.push(issue("missing", `${base}/url`, "url is required for goto"));
  }
  if (ACTIONS_NEEDING_TARGET.includes(action) && !isRecord(step.target)) {
    errors.push(issue("missing", `${base}/target`, `target is required for ${action}`));
  }
}

function checkSteps(
  steps: unknown,
): { errors: ScenarioIssue[]; warnings: ScenarioIssue[] } {
  const errors: ScenarioIssue[] = [];
  const warnings: ScenarioIssue[] = [];
  if (steps === undefined || steps === null) {
    return { errors, warnings };
  }
  if (!Array.isArray(steps)) {
    errors.push(issue("list_type", "/steps", "steps must be a list"));
    return { errors, warnings };
  }
  if (steps.length === 0) {
    errors.push(issue("too_short", "/steps", "steps needs at least one step"));
  }
  if (steps.length > STEPS_MAX) {
    errors.push(issue("too_long", "/steps", `steps allows at most ${STEPS_MAX} steps`));
  }
  steps.forEach((step: unknown, index) => {
    const base = `/steps/${index}`;
    if (!isRecord(step)) {
      errors.push(issue("dict_type", base, "a step must be a mapping"));
      return;
    }
    const adapter = step.adapter;
    if (typeof adapter !== "string" || !ADAPTERS.includes(adapter)) {
      errors.push(
        issue("enum", `${base}/adapter`, `adapter must be one of ${ADAPTERS.join(", ")}`),
      );
      return;
    }
    if (adapter === "browser") {
      checkBrowserStep(step, base, errors);
    } else {
      checkRequestStep(step, base, errors);
    }
    if (step.expect === undefined || step.expect === null) {
      warnings.push(
        issue("no_expectations", `${base}/expect`, "this step has no expectations, so it cannot fail"),
      );
    }
  });
  return { errors, warnings };
}

function syntaxIssues(text: string): ScenarioIssue[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  return document.errors.map((error) => {
    const position = error.linePos?.[0];
    return {
      code: "yaml_syntax",
      pointer: null,
      line: position?.line ?? null,
      column: position?.col ?? null,
      message: error.message.split(FIRST_LINE)[0] ?? error.message,
    };
  });
}

export function checkScenarioYaml(text: string, record: BundleRecord | undefined): ScenarioCheck {
  const syntax = syntaxIssues(text);
  if (syntax.length > 0) {
    return { validation: { valid: false, errors: syntax, warnings: [] }, doc: null };
  }
  const parsed: unknown = parseDocument(text).toJS();
  if (!isRecord(parsed)) {
    return {
      validation: {
        valid: false,
        errors: [issue("not_a_mapping", "", "the scenario must be a YAML mapping")],
        warnings: [],
      },
      doc: null,
    };
  }
  const root = checkRoot(parsed, record);
  const steps = checkSteps(parsed.steps);
  const errors = [...root.errors, ...steps.errors];
  const warnings = [...root.warnings, ...steps.warnings];
  return { validation: { valid: errors.length === 0, errors, warnings }, doc: parsed };
}
