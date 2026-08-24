import { isJsonObject, type JsonObject } from "@/lib/schema/subset";

export const SCHEDULE_SCHEMA_NAME = "schedule";
export const SCHEDULE_SCHEMA_VERSION = 1;
export const SCHEDULE_SCHEMA_STALE_TIME_MS = 60 * 60 * 1000;

export const SCALAR_SCHEDULE_FIELDS = ["tier", "timezone", "enabled"] as const;

const FORM_KEYWORDS = [
  "title",
  "description",
  "type",
  "default",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
] as const;

const DEFINITIONS_PREFIX = "#/$defs/";

export interface ScheduleFormSchemas {
  full: JsonObject;
  scalar: JsonObject;
}

function resolveReference(root: JsonObject, reference: string): JsonObject {
  if (!reference.startsWith(DEFINITIONS_PREFIX) || !isJsonObject(root.$defs)) {
    return {};
  }
  const target = root.$defs[reference.slice(DEFINITIONS_PREFIX.length)];
  return isJsonObject(target) ? target : {};
}

function flattenProperty(root: JsonObject, property: JsonObject): JsonObject {
  const referenced =
    typeof property.$ref === "string" ? resolveReference(root, property.$ref) : {};
  const alternatives = Array.isArray(property.anyOf) ? property.anyOf : [];
  const concrete = alternatives.filter(
    (alternative): alternative is JsonObject =>
      isJsonObject(alternative) && alternative.type !== "null",
  );
  const [only] = concrete;
  const unwrapped = concrete.length === 1 && only !== undefined ? flattenProperty(root, only) : {};
  return { ...referenced, ...unwrapped, ...property };
}

function keepFormKeywords(property: JsonObject): JsonObject {
  return Object.fromEntries(
    FORM_KEYWORDS.filter((keyword) => property[keyword] !== undefined).map((keyword) => [
      keyword,
      property[keyword],
    ]),
  );
}

export function scalarScheduleSchema(schema: unknown): JsonObject {
  const properties: JsonObject = {};
  if (isJsonObject(schema) && isJsonObject(schema.properties)) {
    for (const name of SCALAR_SCHEDULE_FIELDS) {
      const property = schema.properties[name];
      if (isJsonObject(property)) {
        properties[name] = keepFormKeywords(flattenProperty(schema, property));
      }
    }
  }
  const declaredRequired =
    isJsonObject(schema) && Array.isArray(schema.required) ? schema.required : [];
  return {
    type: "object",
    properties,
    required: declaredRequired.filter(
      (name): name is string => typeof name === "string" && name in properties,
    ),
    additionalProperties: false,
  };
}

function withoutIdentifier(schema: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== "$id"));
}

export function toScheduleFormSchemas(document: unknown): ScheduleFormSchemas {
  const full = isJsonObject(document) ? withoutIdentifier(document) : {};
  return { full, scalar: scalarScheduleSchema(full) };
}
