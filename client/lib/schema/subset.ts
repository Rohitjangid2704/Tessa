export type JsonObject = Record<string, unknown>;

export type FieldKind =
  "string" | "date" | "enum" | "integer" | "number" | "boolean" | "list" | "object";

export type FieldDefault = string | number | boolean | string[] | JsonObject;

export interface EnumOption {
  value: string;
  label: string;
  json: string | number;
  description?: string;
}

export const UI_KEYWORD = "x-ui";

export const BUILT_IN_WIDGETS = [
  "text",
  "textarea",
  "select",
  "chips",
  "number",
  "toggle",
  "yaml",
  "sql",
  "json",
] as const;

export interface FieldUiOption {
  label?: string;
  description?: string;
}

export interface FieldUi {
  label?: string;
  group?: string;
  order?: number;
  widget?: string;
  placeholder?: string;
  rows?: number;
  options?: Readonly<Record<string, FieldUiOption>>;
}

export interface FieldBounds {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface FieldSpec {
  name: string;
  kind: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  defaultValue?: FieldDefault;
  options: EnumOption[];
  bounds: FieldBounds;
  ui: FieldUi;
}

export type SchemaPlan =
  { mode: "fields"; fields: FieldSpec[] } | { mode: "empty" } | { mode: "raw"; reason: string };

export const SUPPORTED_TYPES = ["string", "integer", "number", "boolean"] as const;

const OBJECT_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "examples",
  "default",
  UI_KEYWORD,
]);

const PROPERTY_KEYWORDS = new Set([
  "title",
  "description",
  "type",
  "default",
  "examples",
  "enum",
  "format",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  UI_KEYWORD,
]);

const STRUCTURED_BASE_KEYWORDS = ["title", "description", "type", "default", "examples", UI_KEYWORD];

const LIST_KEYWORDS = new Set([
  ...STRUCTURED_BASE_KEYWORDS,
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

const OBJECT_FIELD_KEYWORDS = new Set([
  ...STRUCTURED_BASE_KEYWORDS,
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
]);

const LIST_ITEM_KEYWORDS = new Set(["type", "enum", "minLength", "maxLength", "pattern", "title"]);

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function raw(reason: string): SchemaPlan {
  return { mode: "raw", reason };
}

function quote(keyword: string): string {
  return `\`${keyword}\``;
}

function unsupportedKeyword(schema: JsonObject, allowed: ReadonlySet<string>): string | null {
  return Object.keys(schema).find((keyword) => !allowed.has(keyword)) ?? null;
}

function isSupportedType(value: unknown): value is (typeof SUPPORTED_TYPES)[number] {
  return SUPPORTED_TYPES.some((type) => type === value);
}

function readUi(value: unknown): FieldUi | null {
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    return null;
  }
  const ui: FieldUi = {};
  for (const key of ["label", "group", "widget", "placeholder"] as const) {
    const entry = value[key];
    if (entry === undefined) {
      continue;
    }
    if (typeof entry !== "string" || entry.trim() === "") {
      return null;
    }
    ui[key] = entry.trim();
  }
  for (const key of ["order", "rows"] as const) {
    const entry = value[key];
    if (entry === undefined) {
      continue;
    }
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return null;
    }
    ui[key] = entry;
  }
  if (value.options !== undefined) {
    if (!isJsonObject(value.options)) {
      return null;
    }
    const options: Record<string, FieldUiOption> = {};
    for (const [optionValue, rawOption] of Object.entries(value.options)) {
      if (!isJsonObject(rawOption)) {
        return null;
      }
      const option: FieldUiOption = {};
      if (typeof rawOption.label === "string") {
        option.label = rawOption.label;
      }
      if (typeof rawOption.description === "string") {
        option.description = rawOption.description;
      }
      options[optionValue] = option;
    }
    ui.options = options;
  }
  return ui;
}

function readOptions(candidates: readonly unknown[], ui: FieldUi): EnumOption[] | null {
  if (candidates.length === 0) {
    return null;
  }
  const strings = candidates.every((candidate) => typeof candidate === "string");
  const numbers = candidates.every(
    (candidate) => typeof candidate === "number" && Number.isFinite(candidate),
  );
  if (!strings && !numbers) {
    return null;
  }
  return candidates.map((candidate) => {
    const json = candidate as string | number;
    const value = String(json);
    const hint = ui.options?.[value];
    const option: EnumOption = { value, label: hint?.label ?? value, json };
    if (hint?.description !== undefined) {
      option.description = hint.description;
    }
    return option;
  });
}

function inferType(property: JsonObject): unknown {
  if (property.type !== undefined) {
    return property.type;
  }
  const options = property.enum;
  if (Array.isArray(options) && options.length > 0) {
    if (options.every((option) => typeof option === "string")) {
      return "string";
    }
    if (options.every((option) => typeof option === "number")) {
      return "number";
    }
  }
  return undefined;
}

function readBounds(property: JsonObject): FieldBounds | null {
  const bounds: FieldBounds = {};
  for (const keyword of [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
  ] as const) {
    const value = property[keyword];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    bounds[keyword] = value;
  }
  const pattern = property.pattern;
  if (pattern !== undefined) {
    if (typeof pattern !== "string") {
      return null;
    }
    try {
      new RegExp(pattern, "u");
    } catch {
      return null;
    }
    bounds.pattern = pattern;
  }
  return bounds;
}

function defaultMatches(kind: FieldKind, value: unknown, options: readonly EnumOption[]): boolean {
  switch (kind) {
    case "string":
    case "date":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return options.some((option) => option.json === value);
    case "list":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "object":
      return isJsonObject(value);
  }
}

function resolveKind(property: JsonObject, type: string, hasOptions: boolean): FieldKind | null {
  if (hasOptions) {
    return type === "string" || type === "integer" || type === "number" ? "enum" : null;
  }
  if (type === "string") {
    if (property.format === undefined) {
      return "string";
    }
    return property.format === "date" ? "date" : null;
  }
  if (property.format !== undefined) {
    return null;
  }
  return type === "integer" || type === "number" || type === "boolean" ? type : null;
}

function isValidPattern(pattern: unknown): boolean {
  if (typeof pattern !== "string") {
    return false;
  }
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function readListItems(
  name: string,
  property: JsonObject,
  ui: FieldUi,
): { options: EnumOption[] } | string {
  const items = property.items;
  if (
    !isJsonObject(items) ||
    items.type !== "string" ||
    unsupportedKeyword(items, LIST_ITEM_KEYWORDS) !== null
  ) {
    return `the parameter ${quote(name)} has list items the form cannot show`;
  }
  if (items.pattern !== undefined && !isValidPattern(items.pattern)) {
    return `the parameter ${quote(name)} has list items with a pattern the form cannot read`;
  }
  if (items.enum === undefined) {
    return { options: [] };
  }
  const options = Array.isArray(items.enum) ? readOptions(items.enum, ui) : null;
  if (options === null || options.some((option) => typeof option.json !== "string")) {
    return `the parameter ${quote(name)} has an enum the form cannot show`;
  }
  return { options };
}

function buildSpec(
  name: string,
  property: JsonObject,
  required: boolean,
  ui: FieldUi,
  kind: FieldKind,
  options: EnumOption[],
): FieldSpec | string {
  const bounds = readBounds(property);
  if (bounds === null) {
    return `the parameter ${quote(name)} has constraints the form cannot read`;
  }
  const title = typeof property.title === "string" && property.title !== "" ? property.title : name;
  const spec: FieldSpec = { name, kind, label: ui.label ?? title, required, options, bounds, ui };
  if (typeof property.description === "string" && property.description !== "") {
    spec.description = property.description;
  }
  if (property.default !== undefined) {
    if (!defaultMatches(kind, property.default, options)) {
      return `the default of ${quote(name)} does not match its type`;
    }
    spec.defaultValue = property.default as FieldDefault;
  }
  return spec;
}

function describeStructuredField(
  name: string,
  property: JsonObject,
  required: boolean,
  ui: FieldUi,
  type: "array" | "object",
): FieldSpec | string {
  if (ui.widget === undefined) {
    return `the parameter ${quote(name)} has a type the form cannot show`;
  }
  const keyword = unsupportedKeyword(
    property,
    type === "array" ? LIST_KEYWORDS : OBJECT_FIELD_KEYWORDS,
  );
  if (keyword !== null) {
    return `the parameter ${quote(name)} uses ${quote(keyword)}`;
  }
  if (type === "object") {
    return buildSpec(name, property, required, ui, "object", []);
  }
  const items = readListItems(name, property, ui);
  if (typeof items === "string") {
    return items;
  }
  return buildSpec(name, property, required, ui, "list", items.options);
}

function describeField(name: string, property: JsonObject, required: boolean): FieldSpec | string {
  const ui = readUi(property[UI_KEYWORD]);
  if (ui === null) {
    return `the parameter ${quote(name)} has an ${quote(UI_KEYWORD)} hint the form cannot read`;
  }
  const type = inferType(property);
  if (type === "array" || type === "object") {
    return describeStructuredField(name, property, required, ui, type);
  }
  if (!isSupportedType(type)) {
    return `the parameter ${quote(name)} has a type the form cannot show`;
  }
  const keyword = unsupportedKeyword(property, PROPERTY_KEYWORDS);
  if (keyword !== null) {
    return `the parameter ${quote(name)} uses ${quote(keyword)}`;
  }
  let options: EnumOption[] = [];
  if (property.enum !== undefined) {
    const read = Array.isArray(property.enum) ? readOptions(property.enum, ui) : null;
    if (read === null) {
      return `the parameter ${quote(name)} has an enum the form cannot show`;
    }
    options = read;
  }
  const kind = resolveKind(property, type, options.length > 0);
  if (kind === null) {
    return `the parameter ${quote(name)} uses a format or enum the form cannot show`;
  }
  return buildSpec(name, property, required, ui, kind, options);
}

export function analyzeSchema(schema: unknown): SchemaPlan {
  if (!isJsonObject(schema)) {
    return raw("The schema is not a JSON object.");
  }
  const keyword = unsupportedKeyword(schema, OBJECT_KEYWORDS);
  if (keyword !== null) {
    return raw(`The schema uses ${quote(keyword)}.`);
  }
  if (schema.type !== undefined && schema.type !== "object") {
    return raw("The schema does not describe an object.");
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    return raw("The schema constrains additional properties with a schema.");
  }
  const properties = schema.properties;
  if (properties !== undefined && !isJsonObject(properties)) {
    return raw("The schema has malformed properties.");
  }
  const entries = Object.entries(properties ?? {});
  if (entries.length === 0) {
    return schema.required === undefined ||
      (Array.isArray(schema.required) && schema.required.length === 0)
      ? { mode: "empty" }
      : raw("The schema requires properties it does not declare.");
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    return raw("The schema has a malformed required list.");
  }
  const required = new Set((schema.required ?? []) as unknown[]);
  const declared = new Set(entries.map(([name]) => name));
  for (const name of required) {
    if (typeof name !== "string" || !declared.has(name)) {
      return raw("The schema requires properties it does not declare.");
    }
  }
  const fields: FieldSpec[] = [];
  for (const [name, property] of entries) {
    if (!isJsonObject(property)) {
      return raw(`The parameter ${quote(name)} is not described by an object.`);
    }
    const described = describeField(name, property, required.has(name));
    if (typeof described === "string") {
      return raw(`${described.charAt(0).toUpperCase()}${described.slice(1)}.`);
    }
    fields.push(described);
  }
  return { mode: "fields", fields: sortByOrder(fields) };
}

function sortByOrder(fields: readonly FieldSpec[]): FieldSpec[] {
  return [...fields].sort(
    (left, right) =>
      (left.ui.order ?? Number.MAX_SAFE_INTEGER) - (right.ui.order ?? Number.MAX_SAFE_INTEGER),
  );
}
