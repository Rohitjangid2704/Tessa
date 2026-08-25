import { http } from "msw";
import { z } from "zod";
import { validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import { stageOne } from "../stage1/support";
import { BUNDLE_SOURCE_MODES, bundleSources, PULL_FAILURES } from "../stage9/bundle-source-store";
import { listLibraryBundles } from "../stage9/library-service";
import { LIBRARY_MODES, libraryStore } from "../stage9/library-store";
import type { ErrorDetail } from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const controlBodySchema = z
  .strictObject({
    library: z.enum(LIBRARY_MODES).optional(),
    bundle_source: z.enum(BUNDLE_SOURCE_MODES).optional(),
    pull_failure: z.enum(PULL_FAILURES).optional(),
  })
  .refine(
    (body) =>
      body.library !== undefined ||
      body.bundle_source !== undefined ||
      body.pull_failure !== undefined,
    { message: "Send library, bundle_source, pull_failure or a combination" },
  );

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        loc: ["body", key],
        code: "extra_forbidden",
        message: "Extra inputs are not permitted",
      }));
    }
    return [
      {
        loc: ["body", ...issue.path.map((segment) => String(segment))],
        code: issue.code,
        message: issue.message,
      },
    ];
  });
}

function describeLibraryState(context: ApiContext) {
  const store = stageOne(context);
  if (libraryStore.mode === "default") {
    libraryStore.ensureSeeded(store);
  }
  return {
    library: {
      mode: libraryStore.mode,
      bundles: libraryStore.mode === "default" ? store.bundles.length : 0,
    },
    bundle_source: {
      mode: bundleSources.mode,
      configured_target_ids: bundleSources.configuredTargetIds,
      pull_failure: bundleSources.pullFailure,
    },
  };
}

async function listLibrary(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(listLibraryBundles(stageOne(context), context.url.searchParams));
}

async function controlLibrary(context: ApiContext): Promise<Response> {
  const parsed = controlBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const { library, bundle_source: bundleSource, pull_failure: pullFailure } = parsed.data;
  if (library !== undefined) {
    libraryStore.mode = library;
  }
  if (bundleSource !== undefined) {
    bundleSources.setMode(bundleSource);
  }
  if (pullFailure !== undefined) {
    bundleSources.pullFailure = pullFailure;
  }
  return jsonResponse(describeLibraryState(context));
}

function readLibraryState(context: ApiContext): Response {
  return jsonResponse(describeLibraryState(context));
}

export const libraryHandlers = [
  http.get("*/api/v1/library/bundles", api(listLibrary)),
  http.get("*/__mock/stage9/library", api(readLibraryState, CONTROL_OPTIONS)),
  http.post("*/__mock/stage9/library", api(controlLibrary, CONTROL_OPTIONS)),
];
