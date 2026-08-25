import { createHash } from "node:crypto";
import { http } from "msw";
import bundleSchema from "../fixtures/bundle.v1.json";
import goalSchema from "../fixtures/goal.v1.json";
import mutantSchema from "../fixtures/mutant.v1.json";
import personaSchema from "../fixtures/persona.v1.json";
import scenarioSchema from "../fixtures/scenario.v1.json";
import scheduleSchema from "../fixtures/schedule.v1.json";
import streamEventSchema from "../fixtures/stream-event.v1.json";
import { notFound } from "../factories/errors";
import type { SchemaIndex } from "../types";
import { api, jsonResponse, pathParam, type ApiContext } from "./api";

interface PublishedSchema {
  name: string;
  version: number;
  stage: number;
  document: Record<string, unknown>;
}

const SCHEMA_FILE_PATTERN = /^([a-z][a-z0-9-]*)\.v(\d+)\.json$/;
const SCHEMA_CACHE_CONTROL = "public, max-age=3600";
const SCHEMA_CONTENT_TYPE = "application/schema+json";

const PUBLISHED_SCHEMAS: PublishedSchema[] = [
  { name: "bundle", version: 1, stage: 0, document: bundleSchema },
  { name: "stream-event", version: 1, stage: 0, document: streamEventSchema },
  { name: "scenario", version: 1, stage: 2, document: scenarioSchema },
  { name: "persona", version: 1, stage: 7, document: personaSchema },
  { name: "goal", version: 1, stage: 7, document: goalSchema },
  { name: "schedule", version: 1, stage: 8, document: scheduleSchema },
  { name: "mutant", version: 1, stage: 8, document: mutantSchema },
];

function schemaUrl(origin: string, schema: PublishedSchema): string {
  return `${origin}/schemas/${schema.name}.v${schema.version}.json`;
}

function renderSchema(origin: string, schema: PublishedSchema): { body: string; sha256: string } {
  const body = JSON.stringify({ ...schema.document, $id: schemaUrl(origin, schema) }, null, 2);
  return { body, sha256: createHash("sha256").update(body).digest("hex") };
}

function readSchemaIndex(context: ApiContext): Response {
  const { origin } = context.url;
  const index: SchemaIndex = {
    schemas: PUBLISHED_SCHEMAS.map((schema) => ({
      name: schema.name,
      version: schema.version,
      url: schemaUrl(origin, schema),
      sha256: renderSchema(origin, schema).sha256,
      stage: schema.stage,
    })),
  };
  return jsonResponse(index, { headers: { "Cache-Control": SCHEMA_CACHE_CONTROL } });
}

function readSchema(context: ApiContext): Response {
  const [, name, version] = SCHEMA_FILE_PATTERN.exec(pathParam(context, "file")) ?? [];
  const schema = PUBLISHED_SCHEMAS.find(
    (candidate) => candidate.name === name && candidate.version === Number(version),
  );
  if (schema === undefined) {
    throw notFound();
  }
  const { body, sha256 } = renderSchema(context.url.origin, schema);
  const etag = `"${sha256}"`;
  const headers = {
    "Cache-Control": SCHEMA_CACHE_CONTROL,
    "Content-Type": SCHEMA_CONTENT_TYPE,
    ETag: etag,
  };
  if (context.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

export const schemaHandlers = [
  http.get("*/schemas/index.json", api(readSchemaIndex)),
  http.get("*/schemas/:file", api(readSchema)),
];
