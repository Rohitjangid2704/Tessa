import { http } from "msw";
import type { SecretName, ServiceName, ServiceTestResult } from "@/lib/api/types";
import { validationFailed } from "../factories/errors";
import { nowIso } from "../factories/targets";
import { parseJsonObject } from "../factories/validation";
import type { ServiceTestName } from "../server/faults";
import { parseSettingsPatch } from "../stage4/settings-patch";
import { ALL_SERVICES, SECRET_NAMES } from "../stage4/settings-spec";
import type { SettingsStore } from "../stage4/settings-store";
import { stageFour } from "../stage4/support";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, pathParam, requireUser, type ApiContext } from "./api";

const SECRET_MAX_LENGTH = 4096;

const SERVICE_LATENCY_MS: Record<ServiceTestName, number> = {
  laya: 12,
  openai: 184,
  anthropic: 212,
  jev: 95,
  temporal: 6,
  slack: 143,
  smtp: 268,
};

const SERVICE_FAILURE_MESSAGE: Record<ServiceTestName, string> = {
  laya: "Connection refused by Laya",
  openai: "The provider answered 401 Unauthorized",
  anthropic: "The provider answered 401 Unauthorized",
  jev: "Connection refused by Jev",
  temporal: "Temporal did not answer within 5 s",
  slack: "Slack answered 404 no_service: the webhook was revoked",
  smtp: "The mail server refused the login (535 authentication failed)",
};

const NOT_CONFIGURED = "not configured";

function settingsOf(context: ApiContext): SettingsStore {
  return stageFour(context).settings;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invalidPathEnum(parameter: string, allowed: readonly string[]) {
  const options = allowed.map((option) => `'${option}'`);
  const last = options.pop() ?? "";
  return validationFailed([
    {
      loc: ["path", parameter],
      code: "enum",
      message: `Input should be ${options.join(", ")} or ${last}`,
    },
  ]);
}

function secretNameParam(context: ApiContext): SecretName {
  const raw = pathParam(context, "name");
  const known = SECRET_NAMES.find((name) => name === raw);
  if (known === undefined) {
    throw invalidPathEnum("name", SECRET_NAMES);
  }
  return known;
}

function serviceParam(context: ApiContext): ServiceName {
  const raw = pathParam(context, "service");
  const known = ALL_SERVICES.find((service) => service === raw);
  if (known === undefined) {
    throw invalidPathEnum("service", ALL_SERVICES);
  }
  return known;
}

async function readSettings(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(settingsOf(context).read());
}

async function patchSettings(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const parsed = parseSettingsPatch(parseJsonObject(await context.request.text()));
  if (context.state.faults.settings422) {
    const first = parsed.leaves[0];
    throw validationFailed([
      {
        loc: ["body", ...(first?.path ?? [])],
        code: "value_error",
        message: "The mock fault settings_422 rejected this value",
      },
    ]);
  }
  if (parsed.details.length > 0) {
    throw validationFailed(parsed.details);
  }
  const store = settingsOf(context);
  store.apply(parsed.leaves);
  return jsonResponse(store.read());
}

function parseSecretBody(name: SecretName, raw: Record<string, unknown>): void {
  const details: ErrorDetail[] = [];
  const value = raw.value;
  if (value === undefined) {
    details.push({ loc: ["body", "value"], code: "missing", message: "Field required" });
  } else if (typeof value !== "string") {
    details.push({
      loc: ["body", "value"],
      code: "string_type",
      message: "Input should be a valid string",
    });
  } else if (value.length < 1) {
    details.push({
      loc: ["body", "value"],
      code: "string_too_short",
      message: "String should have at least 1 character",
    });
  } else if (value.length > SECRET_MAX_LENGTH) {
    details.push({
      loc: ["body", "value"],
      code: "string_too_long",
      message: `String should have at most ${SECRET_MAX_LENGTH} characters`,
    });
  } else if (name === "slack_webhook_url" && !value.startsWith("https://")) {
    details.push({
      loc: ["body", "value"],
      code: "url_scheme",
      message: "A Slack webhook is an https URL",
    });
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }
}

async function putSecret(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "admin");
  const name = secretNameParam(context);
  parseSecretBody(name, parseJsonObject(await context.request.text()));
  return jsonResponse(settingsOf(context).markSecretSet(name, user.id, nowIso()));
}

async function deleteSecret(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const name = secretNameParam(context);
  settingsOf(context).markSecretCleared(name);
  return new Response(null, { status: 204 });
}

function probeService(
  context: ApiContext,
  service: ServiceTestName,
): Omit<ServiceTestResult, "service"> {
  const store = settingsOf(context);
  const { faults } = context.state;
  const failed = {
    ok: false,
    latency_ms: null,
    message: SERVICE_FAILURE_MESSAGE[service],
  } as const;
  if (faults.isServiceTestFailing(service)) {
    return failed;
  }
  const unconfigured = { ok: false, latency_ms: null, message: NOT_CONFIGURED } as const;
  switch (service) {
    case "laya":
    case "temporal":
      return faults.isDependencyDown(service)
        ? failed
        : { ok: true, latency_ms: SERVICE_LATENCY_MS[service], message: null };
    case "openai":
      return store.hasSecret("openai_api_key")
        ? { ok: true, latency_ms: SERVICE_LATENCY_MS.openai, message: null }
        : unconfigured;
    case "anthropic":
      return store.hasSecret("anthropic_api_key")
        ? { ok: true, latency_ms: SERVICE_LATENCY_MS.anthropic, message: null }
        : unconfigured;
    case "jev":
      return store.read().endpoints.jev_url !== null && store.hasSecret("jev_api_key")
        ? { ok: true, latency_ms: SERVICE_LATENCY_MS.jev, message: null }
        : unconfigured;
    case "slack":
      return store.hasSecret("slack_webhook_url")
        ? { ok: true, latency_ms: SERVICE_LATENCY_MS.slack, message: null }
        : unconfigured;
    case "smtp":
      return store.hasSecret("smtp_password")
        ? { ok: true, latency_ms: SERVICE_LATENCY_MS.smtp, message: null }
        : unconfigured;
  }
}

async function testService(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const service = serviceParam(context);
  if (context.state.faults.healthSlowMs > 0) {
    await sleep(context.state.faults.healthSlowMs);
  }
  return jsonResponse({ service, ...probeService(context, service) });
}

export const settingsHandlers = [
  http.get("*/api/v1/settings", api(readSettings)),
  http.patch("*/api/v1/settings", api(patchSettings)),
  http.put("*/api/v1/settings/secrets/:name", api(putSecret)),
  http.delete("*/api/v1/settings/secrets/:name", api(deleteSecret)),
  http.post("*/api/v1/settings/test/:service", api(testService)),
];
