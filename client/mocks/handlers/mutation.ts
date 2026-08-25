import { http } from "msw";
import { z } from "zod";
import { conflict, notFound, validationFailed } from "../factories/errors";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import {
  hashParts,
  pathUuid,
  requireActiveTarget,
  requireIdempotencyKey,
  requireTarget,
  withIdempotency,
} from "../stage1/support";
import { ensureMutationSeed } from "../stage8/mutation-seed";
import {
  applyMutantChanges,
  createMutant,
  hasActiveRun,
  MUTANT_STATUSES,
  parseMutantCreate,
  parseMutantUpdate,
  parseMutationRunCreate,
  startMutationRun,
} from "../stage8/mutation-service";
import { mutationStore, RUN_BEHAVIOURS, type StoredMutationRun } from "../stage8/mutation-store";
import { stageEight } from "../stage8/store";
import type { ErrorDetail } from "../types";
import type { Mutant, MutationRun } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

mutationStore.scenarioSource = () => stageEight.mutationScenario;

const CONTROL_OPTIONS = { applyLatency: false };

const MUTANT_PAGE: PageSpec<Mutant> = {
  sortKeys: {
    created_at: { kind: "timestamp", value: (row) => row.created_at },
    name: { kind: "text", value: (row) => row.name },
    status: { kind: "text", value: (row) => row.status },
  },
  defaultSort: "created_at",
  getId: (row) => row.id,
};

const RUN_PAGE: PageSpec<MutationRun> = {
  sortKeys: {
    started_at: { kind: "timestamp", value: (row) => row.started_at },
  },
  defaultSort: "-started_at",
  getId: (row) => row.id,
};

function prepare(context: ApiContext): void {
  ensureMutationSeed(context.state);
}

function requireMutant(context: ApiContext): Mutant {
  const mutant = mutationStore.findMutant(pathUuid(context, "mutant_id"));
  if (mutant === undefined) {
    throw notFound("Mutant not found");
  }
  return mutant;
}

function requireStoredRun(context: ApiContext): StoredMutationRun {
  const stored = mutationStore.findRun(pathUuid(context, "mutation_run_id"));
  if (stored === undefined) {
    throw notFound("Mutation run not found");
  }
  return stored;
}

async function listMutants(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  prepare(context);
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const statuses = query.enumList("status", MUTANT_STATUSES);
  const paginate = readPage(query, MUTANT_PAGE);
  query.finish();
  if (targetId !== undefined) {
    requireTarget(context, targetId.toLowerCase());
  }
  const rows = mutationStore.mutants
    .filter((mutant) => targetId === undefined || mutant.target_id === targetId.toLowerCase())
    .filter((mutant) => statuses === undefined || statuses.includes(mutant.status));
  return jsonResponse(paginate(rows));
}

async function readMutant(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  prepare(context);
  return jsonResponse(requireMutant(context));
}

async function postMutant(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  prepare(context);
  const raw = await context.request.text();
  const parsed = parseMutantCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      requireActiveTarget(context, parsed.targetId);
      return { status: 201, body: createMutant(parsed) };
    },
  );
}

async function patchMutant(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  prepare(context);
  const mutant = requireMutant(context);
  const changes = parseMutantUpdate(parseJsonObject(await context.request.text()));
  return jsonResponse(applyMutantChanges(mutant, changes));
}

async function removeMutant(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  prepare(context);
  const mutant = requireMutant(context);
  if (hasActiveRun(mutant.id)) {
    throw conflict("conflict", `A mutation run for ${mutant.name} is in progress`);
  }
  mutationStore.removeMutant(mutant.id);
  return new Response(null, { status: 204 });
}

async function postMutationRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  prepare(context);
  requireIdempotencyKey(context);
  const raw = await context.request.text();
  const parsed = parseMutationRunCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: true, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => ({ status: 202, body: startMutationRun(context, user, parsed) }),
  );
}

async function listMutationRuns(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  prepare(context);
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const mutantId = query.uuid("mutant_id");
  const paginate = readPage(query, RUN_PAGE);
  query.finish();
  if (targetId !== undefined) {
    requireTarget(context, targetId.toLowerCase());
  }
  const rows = mutationStore.runs
    .filter((stored) => {
      const mutant = mutationStore.findMutant(stored.mutantId);
      return (
        mutant !== undefined &&
        (targetId === undefined || mutant.target_id === targetId.toLowerCase()) &&
        (mutantId === undefined || stored.mutantId === mutantId.toLowerCase())
      );
    })
    .map((stored) => mutationStore.toWire(stored));
  return jsonResponse(paginate(rows));
}

async function readMutationRun(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  prepare(context);
  return jsonResponse(mutationStore.toWire(requireStoredRun(context)));
}

async function readSummary(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  prepare(context);
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id", { required: true });
  query.finish();
  if (targetId === undefined) {
    throw validationFailed([
      { loc: ["query", "target_id"], code: "missing", message: "Field required" },
    ]);
  }
  const target = requireTarget(context, targetId.toLowerCase());
  return jsonResponse(mutationStore.summaryFor(target.id));
}

const controlBodySchema = z.strictObject({
  next_run: z.enum(RUN_BEHAVIOURS).optional(),
});

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

function describeMutation() {
  return {
    seeded_scenario: mutationStore.seededScenario,
    next_run: mutationStore.nextRun,
    mutants: mutationStore.mutants.length,
    runs: mutationStore.runs.length,
  };
}

async function controlMutation(context: ApiContext): Promise<Response> {
  const parsed = controlBodySchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  prepare(context);
  if (parsed.data.next_run !== undefined) {
    mutationStore.nextRun = parsed.data.next_run;
  }
  return jsonResponse(describeMutation());
}

async function readControl(context: ApiContext): Promise<Response> {
  prepare(context);
  return jsonResponse(describeMutation());
}

export const mutationHandlers = [
  http.get("*/api/v1/mutants", api(listMutants)),
  http.post("*/api/v1/mutants", api(postMutant)),
  http.get("*/api/v1/mutants/:mutant_id", api(readMutant)),
  http.patch("*/api/v1/mutants/:mutant_id", api(patchMutant)),
  http.delete("*/api/v1/mutants/:mutant_id", api(removeMutant)),
  http.post("*/api/v1/mutation-runs", api(postMutationRun)),
  http.get("*/api/v1/mutation-runs", api(listMutationRuns)),
  http.get("*/api/v1/mutation-runs/:mutation_run_id", api(readMutationRun)),
  http.get("*/api/v1/mutation/summary", api(readSummary)),
  http.get("*/__mock/stage8/mutation", api(readControl, CONTROL_OPTIONS)),
  http.post("*/__mock/stage8/mutation", api(controlMutation, CONTROL_OPTIONS)),
];
