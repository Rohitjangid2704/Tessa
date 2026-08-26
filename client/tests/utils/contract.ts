import { readFileSync } from "node:fs";
import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";

export type JsonObject = Record<string, unknown>;

export interface OpenApiMediaType {
  schema?: JsonObject;
}

export interface OpenApiOperation {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: JsonObject }>;
  requestBody?: { required?: boolean; content: Record<string, OpenApiMediaType> };
  responses: Record<string, { content?: Record<string, OpenApiMediaType> }>;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, JsonObject> };
}

export interface ContractCheck {
  valid: boolean;
  errors: string[];
}

const REPO_ROOT = path.resolve(process.cwd(), "..");
const CONTRACT_ID = "https://contract.tessa.test/openapi";
const SCHEMA_REFERENCE_PREFIX = "#/components/schemas/";

let cachedOpenApi: OpenApiDocument | null = null;

export function readOpenApi(): OpenApiDocument {
  cachedOpenApi ??= JSON.parse(
    readFileSync(path.join(REPO_ROOT, "api", "openapi.json"), "utf8"),
  ) as OpenApiDocument;
  return cachedOpenApi;
}

export function readPublishedSchema(file: string): JsonObject {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "schemas", file), "utf8")) as JsonObject;
}

function qualifyReferences(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(qualifyReferences);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] =
      key === "$ref" && typeof value === "string" && value.startsWith(SCHEMA_REFERENCE_PREFIX)
        ? `${CONTRACT_ID}${value}`
        : qualifyReferences(value);
  }
  return copy;
}

function describeErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const location = error.instancePath === "" ? "(body)" : error.instancePath;
    const detail = Object.entries(error.params)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    return `${location} ${error.message ?? "is invalid"} ${detail}`.trim();
  });
}

export class ContractValidator {
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(private readonly document: OpenApiDocument = readOpenApi()) {
    this.ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
      validateSchema: false,
      logger: false,
    });
    this.ajv.addSchema({ $id: CONTRACT_ID, components: this.document.components });
  }

  operation(method: string, pathTemplate: string): OpenApiOperation {
    const operation = this.document.paths[pathTemplate]?.[method.toLowerCase()];
    if (operation === undefined) {
      throw new Error(`The OpenAPI document has no ${method} ${pathTemplate}`);
    }
    return operation;
  }

  operations(): Array<{ method: string; path: string }> {
    return Object.entries(this.document.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((method) => method !== "parameters")
        .map((method) => ({ method, path })),
    );
  }

  responseStatuses(method: string, pathTemplate: string): string[] {
    return Object.keys(this.operation(method, pathTemplate).responses);
  }

  schemaNames(): string[] {
    return Object.keys(this.document.components.schemas);
  }

  private compile(cacheKey: string, schema: JsonObject): ValidateFunction {
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const compiled = this.ajv.compile(qualifyReferences(schema) as JsonObject);
    this.cache.set(cacheKey, compiled);
    return compiled;
  }

  private run(validate: ValidateFunction, value: unknown): ContractCheck {
    const valid = validate(value) === true;
    return { valid, errors: valid ? [] : describeErrors(validate.errors) };
  }

  checkSchema(name: string, value: unknown): ContractCheck {
    return this.run(
      this.compile(`schema:${name}`, { $ref: `${SCHEMA_REFERENCE_PREFIX}${name}` }),
      value,
    );
  }

  checkResponse(
    method: string,
    pathTemplate: string,
    status: number,
    value: unknown,
    contentType = "application/json",
  ): ContractCheck {
    const response = this.operation(method, pathTemplate).responses[String(status)];
    if (response === undefined) {
      return {
        valid: false,
        errors: [`${method} ${pathTemplate} does not declare a ${status} response`],
      };
    }
    const schema = response.content?.[contentType]?.schema;
    if (schema === undefined) {
      return {
        valid: false,
        errors: [`${method} ${pathTemplate} ${status} declares no ${contentType} body`],
      };
    }
    return this.run(
      this.compile(`response:${method}:${pathTemplate}:${status}:${contentType}`, schema),
      value,
    );
  }

  checkRequestBody(method: string, pathTemplate: string, value: unknown): ContractCheck {
    const schema = this.operation(method, pathTemplate).requestBody?.content["application/json"]
      ?.schema;
    if (schema === undefined) {
      return { valid: false, errors: [`${method} ${pathTemplate} declares no JSON request body`] };
    }
    return this.run(this.compile(`request:${method}:${pathTemplate}`, schema), value);
  }
}

export function createContractValidator(): ContractValidator {
  return new ContractValidator();
}

export function publishedStreamEventTypes(): string[] {
  const schema = readPublishedSchema("stream-event.v1.json");
  const definitions = schema.$defs as Record<string, { properties: { type: { const: string } } }>;
  const variants = schema.oneOf as Array<{ $ref: string }>;
  return variants.map((variant) => {
    const definition = definitions[variant.$ref.split("/").pop() ?? ""];
    if (definition === undefined) {
      throw new Error(`stream-event.v1.json has no definition for ${variant.$ref}`);
    }
    return definition.properties.type.const;
  });
}

export function createPublishedStreamEventCheck(): (envelope: unknown) => string[] {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    validateSchema: false,
    logger: false,
  });
  const validate = ajv.compile(readPublishedSchema("stream-event.v1.json"));
  return (envelope) => (validate(envelope) === true ? [] : describeErrors(validate.errors));
}
