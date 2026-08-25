import { http } from "msw";
import { MockApiError, notFound } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { hashParts, pathUuid, requireActiveTarget, withIdempotency } from "../stage1/support";
import { ensureSimulationHistory } from "../stage7/sim-history";
import { parsePersonaCreate, parsePersonaUpdate, SEARCH_MAX } from "../stage7/sim-requests";
import { simulatorsOf } from "../stage7/sim-store";
import type { Persona } from "@/lib/api/types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const PERSONA_PAGE: PageSpec<Persona> = {
  sortKeys: { name: { kind: "text", value: (row) => row.name } },
  defaultSort: "name",
  getId: (row) => row.id,
};

function duplicateName(): MockApiError {
  const message = "A persona with this name already exists for the target";
  return new MockApiError(409, "conflict", message, [
    { loc: ["body", "name"], code: "already_exists", message },
  ]);
}

function personaInUse(): MockApiError {
  return new MockApiError(
    409,
    "conflict",
    "This persona is used by simulation sessions and cannot be deleted",
    [
      {
        loc: ["path", "persona_id"],
        code: "in_use",
        message: "Sessions of past simulations still refer to this persona",
      },
    ],
  );
}

async function listPersonas(context: ApiContext): Promise<Response> {
  ensureSimulationHistory(context.state);
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const targetId = query.uuid("target_id");
  const text = query.text("q", { max: SEARCH_MAX });
  const paginate = readPage(query, PERSONA_PAGE);
  query.finish();
  const needle = text?.toLowerCase();
  const rows = simulatorsOf(context.state).personas.personas.filter(
    (persona) =>
      (targetId === undefined || persona.target_id === targetId.toLowerCase()) &&
      (needle === undefined ||
        persona.name.toLowerCase().includes(needle) ||
        persona.description.toLowerCase().includes(needle)),
  );
  return jsonResponse(paginate(rows));
}

async function createPersona(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "member");
  const raw = await context.request.text();
  const input = parsePersonaCreate(parseJsonObject(raw));
  return withIdempotency(
    context,
    user,
    { required: false, requestHash: hashParts("POST", context.url.pathname, raw) },
    () => {
      const target = requireActiveTarget(context, input.target_id);
      const { personas } = simulatorsOf(context.state);
      if (personas.nameTaken(target.id, input.name)) {
        throw duplicateName();
      }
      const persona: Persona = {
        id: newId(),
        target_id: target.id,
        name: input.name,
        description: input.description,
        traits: input.traits,
        created_by: user.id,
      };
      personas.add(persona);
      return { status: 201, body: persona };
    },
  );
}

function requirePersona(context: ApiContext): Persona {
  const persona = simulatorsOf(context.state).personas.find(pathUuid(context, "persona_id"));
  if (persona === undefined) {
    throw notFound("Persona not found");
  }
  return persona;
}

async function readPersona(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse(requirePersona(context));
}

async function updatePersona(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const current = requirePersona(context);
  const change = parsePersonaUpdate(parseJsonObject(await context.request.text()));
  const { personas } = simulatorsOf(context.state);
  if (change.name !== undefined && personas.nameTaken(current.target_id, change.name, current.id)) {
    throw duplicateName();
  }
  const updated: Persona = { ...current, ...change };
  personas.replace(updated);
  return jsonResponse(updated);
}

async function deletePersona(context: ApiContext): Promise<Response> {
  await requireUser(context, "member");
  const current = requirePersona(context);
  const simulators = simulatorsOf(context.state);
  if (simulators.personaInUse(current.id)) {
    throw personaInUse();
  }
  simulators.personas.remove(current.id);
  return new Response(null, { status: 204 });
}

export const personaHandlers = [
  http.get("*/api/v1/personas", api(listPersonas)),
  http.post("*/api/v1/personas", api(createPersona)),
  http.get("*/api/v1/personas/:persona_id", api(readPersona)),
  http.patch("*/api/v1/personas/:persona_id", api(updatePersona)),
  http.delete("*/api/v1/personas/:persona_id", api(deletePersona)),
];
