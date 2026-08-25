import { MockApiError, validationFailed } from "../factories/errors";
import type { ApiContext } from "../handlers/api";
import { launchRun } from "../server/run-simulator";
import { BodyReader, type Source } from "../stage1/body";
import type { BundleRecord, EnvironmentEntry, TargetRecord } from "../stage1/store";
import { buildConfigSnapshot } from "../stage2/plan-service";
import { nowIso, stageTwo } from "../stage2/support";
import type { MockUser } from "../types";
import { bundleSources, DEFAULT_SOURCE_PATH, GIT_ALLOWED_HOSTS } from "./bundle-source-store";
import type { BundleSource, RunConfigSnapshot, RunHandle } from "@/lib/api/types";
import "./import-script";

export const GIT_URL_MAX_LENGTH = 2048;
export const BRANCH_MAX_LENGTH = 255;
export const PATH_MAX_LENGTH = 255;
export const CREDENTIAL_MAX_LENGTH = 200;
export const REF_MAX_LENGTH = 255;
export const MISSING_REF = "missing";
export const UNREACHABLE_REF = "unreachable";
export const BROKEN_REPOSITORY = "broken-repo";

const CREDENTIAL_KINDS: readonly string[] = ["token", "password"];
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const IMPORT_BUDGET_MINUTES = 5;
const PLACEHOLDER_HASH_LENGTH = 64;

export interface ParsedBundleSourceSet {
  git_url: string;
  branch: string;
  path: string;
  credential_name: string;
}

function gitUrlIssue(raw: string): { code: string; message: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      code: "url_parsing",
      message: "Input should be a valid URL, relative URL without a base",
    };
  }
  if (url.protocol !== "https:") {
    return { code: "url_scheme", message: "URL scheme should be 'https'" };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      code: "git_url_userinfo",
      message: "The git URL must not contain a username or password; name a credential instead",
    };
  }
  if (!GIT_ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    return {
      code: "git_host_not_allowed",
      message: `Host '${url.hostname}' is not in TESSA_GIT_ALLOWED_HOSTS (${GIT_ALLOWED_HOSTS.join(", ")})`,
    };
  }
  return null;
}

function credentialIssue(
  environment: readonly EnvironmentEntry[],
  name: string,
): { code: string; message: string } | null {
  const variable = environment.find((entry) => entry.name === name && !entry.stale);
  if (variable === undefined) {
    return {
      code: "credential_not_found",
      message: `The target has no environment variable named '${name}'`,
    };
  }
  if (!CREDENTIAL_KINDS.includes(variable.kind)) {
    return {
      code: "credential_kind",
      message: `'${name}' is a ${variable.kind} variable; choose a token or password variable`,
    };
  }
  return null;
}

function pathIssue(path: string): { code: string; message: string } | null {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    return {
      code: "path_invalid",
      message: "The path must be relative to the repository root and must not contain '..'",
    };
  }
  return null;
}

export function parseBundleSourceSet(
  body: Source,
  environment: readonly EnvironmentEntry[],
): ParsedBundleSourceSet {
  const reader = new BodyReader(body);
  const gitUrl = reader.string("git_url", {
    required: true,
    min: 1,
    max: GIT_URL_MAX_LENGTH,
    strip: true,
  });
  const branch = reader.string("branch", {
    required: true,
    min: 1,
    max: BRANCH_MAX_LENGTH,
    strip: true,
  });
  const path = reader.string("path", {
    required: false,
    nullable: true,
    max: PATH_MAX_LENGTH,
    strip: true,
  });
  const credential = reader.string("credential_name", {
    required: true,
    min: 1,
    max: CREDENTIAL_MAX_LENGTH,
    strip: true,
  });
  const resolvedPath =
    path === undefined || path === null || path === "" ? DEFAULT_SOURCE_PATH : path;
  const checks: Array<[string, { code: string; message: string } | null]> = [
    ["git_url", typeof gitUrl === "string" ? gitUrlIssue(gitUrl) : null],
    ["path", pathIssue(resolvedPath)],
    [
      "credential_name",
      typeof credential === "string" ? credentialIssue(environment, credential) : null,
    ],
  ];
  const details = [...reader.details];
  for (const [field, issue] of checks) {
    if (issue !== null) {
      details.push({ loc: ["body", field], code: issue.code, message: issue.message });
    }
  }
  if (
    details.length > 0 ||
    typeof gitUrl !== "string" ||
    typeof branch !== "string" ||
    typeof credential !== "string"
  ) {
    throw validationFailed(details);
  }
  return {
    git_url: gitUrl,
    branch,
    path: resolvedPath,
    credential_name: credential,
  };
}

export function parsePullBody(body: Source): string | null {
  const reader = new BodyReader(body);
  const ref = reader.string("ref", {
    required: false,
    nullable: true,
    min: 1,
    max: REF_MAX_LENGTH,
    strip: true,
  });
  if (reader.details.length > 0) {
    throw validationFailed(reader.details);
  }
  return typeof ref === "string" ? ref : null;
}

export function upstreamUnreachable(source: BundleSource): MockApiError {
  return new MockApiError(502, "upstream_error", "The git host could not be reached", [
    {
      loc: ["git_url"],
      code: "clone_failed",
      message: `git clone of ${source.git_url} failed: could not resolve the host`,
    },
  ]);
}

function placeholderSnapshot(createdAt: string): RunConfigSnapshot {
  return {
    bundle_id: NIL_UUID,
    bundle_version: 0,
    bundle_hash: "0".repeat(PLACEHOLDER_HASH_LENGTH),
    seed_hash: null,
    clock: { mode: "real", at: createdAt },
    models: {},
    probe_bank_version: null,
    prompt_template_versions: {},
    scenario_versions: {},
  };
}

function configSnapshotFor(latest: BundleRecord | undefined, createdAt: string) {
  return latest === undefined
    ? placeholderSnapshot(createdAt)
    : buildConfigSnapshot(latest, createdAt);
}

export function repositoryName(gitUrl: string): string {
  const last = gitUrl.split("/").at(-1) ?? "";
  return last.replace(/\.git$/, "");
}

export function shouldFailImport(source: BundleSource, ref: string): boolean {
  return (
    bundleSources.pullFailure === "run" ||
    ref === MISSING_REF ||
    repositoryName(source.git_url) === BROKEN_REPOSITORY
  );
}

export function startBundleImport(
  context: ApiContext,
  user: MockUser,
  target: TargetRecord,
  source: BundleSource,
  requestedRef: string | null,
): RunHandle {
  const { state } = context;
  const ref = requestedRef ?? source.branch;
  if (bundleSources.pullFailure === "request" || ref === UNREACHABLE_REF) {
    throw upstreamUnreachable(source);
  }
  const createdAt = nowIso();
  const latest = state.stageOne.latestBundle(target.id);
  const entry = launchRun(state, stageTwo(context), {
    kind: "import",
    createdBy: user.id,
    targetId: target.id,
    planId: null,
    bundleId: null,
    readOnly: false,
    budget: { max_usd: 0, max_minutes: IMPORT_BUDGET_MINUTES },
    configSnapshot: configSnapshotFor(latest, createdAt),
    params: {
      target_id: target.id,
      user_id: user.id,
      ref,
      git_url: source.git_url,
      branch: source.branch,
      path: source.path,
      fail: shouldFailImport(source, ref),
    },
  });
  return {
    run_id: entry.run.id,
    workflow_id: entry.run.workflow_id,
    kind: entry.run.kind,
    status: entry.run.status,
    created_at: entry.run.created_at,
  };
}
