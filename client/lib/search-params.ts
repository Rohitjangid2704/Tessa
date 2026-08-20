import { z } from "zod";
import { sortingToSortParam, sortParamToSorting } from "./api/pagination";

export interface SearchParamsLike {
  keys(): Iterable<string>;
  getAll(name: string): string[];
}

export type RawSearchParams = Record<string, string[]>;

export const DEFAULT_TEXT_MAX_LENGTH = 200;
export const DEFAULT_LIST_MAX_ITEMS = 50;

const TRUE_TEXT = new Set(["true", "1"]);
const FALSE_TEXT = new Set(["false", "0"]);

function firstValue(raw: unknown): string | undefined {
  return Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : undefined;
}

function allValues(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

function nonEmptyOrUndefined<Item>(items: Item[]): Item[] | undefined {
  return items.length === 0 ? undefined : items;
}

export function toRawSearchParams(
  source: SearchParamsLike,
  keys?: readonly string[],
): RawSearchParams {
  const raw: RawSearchParams = {};
  for (const key of new Set(source.keys())) {
    if (keys === undefined || keys.includes(key)) {
      raw[key] = source.getAll(key);
    }
  }
  return raw;
}

export function textParam(maxLength: number = DEFAULT_TEXT_MAX_LENGTH) {
  return z.preprocess((raw) => {
    const value = firstValue(raw)?.trim();
    return value === undefined || value === "" ? undefined : value.slice(0, maxLength);
  }, z.string().optional());
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam() {
  return z.preprocess((raw) => {
    const value = firstValue(raw)?.trim();
    return value !== undefined && UUID_TEXT.test(value) ? value.toLowerCase() : undefined;
  }, z.string().optional());
}

export function booleanParam() {
  return z.preprocess((raw) => {
    const value = firstValue(raw)?.trim().toLowerCase();
    if (value !== undefined && TRUE_TEXT.has(value)) {
      return true;
    }
    return value !== undefined && FALSE_TEXT.has(value) ? false : undefined;
  }, z.boolean().optional());
}

export function enumParam<const Value extends string>(allowed: readonly Value[]) {
  return z.preprocess(
    (raw) => {
      const value = firstValue(raw);
      return allowed.find((candidate) => candidate === value);
    },
    z.enum(allowed as [Value, ...Value[]]).optional(),
  );
}

export function enumListParam<const Value extends string>(allowed: readonly Value[]) {
  return z.preprocess(
    (raw) => nonEmptyOrUndefined(allowed.filter((candidate) => allValues(raw).includes(candidate))),
    z.array(z.enum(allowed as [Value, ...Value[]])).optional(),
  );
}

export function sortParam(allowedKeys: readonly string[]) {
  return z.preprocess((raw) => {
    const value = firstValue(raw);
    return value === undefined
      ? undefined
      : sortingToSortParam(sortParamToSorting(value, allowedKeys));
  }, z.string().optional());
}

export function stringListParam(options: { maxItems?: number; maxLength?: number } = {}) {
  const maxItems = options.maxItems ?? DEFAULT_LIST_MAX_ITEMS;
  const maxLength = options.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
  return z.preprocess(
    (raw) =>
      nonEmptyOrUndefined(
        [
          ...new Set(
            allValues(raw)
              .map((value) => value.trim().slice(0, maxLength))
              .filter((value) => value !== ""),
          ),
        ].slice(0, maxItems),
      ),
    z.array(z.string()).optional(),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendValue(target: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendValue(target, key, item);
    }
    return;
  }
  target.append(key, String(value));
}

export interface SearchParamsCodecOptions<Values> {
  defaults?: Partial<Values>;
}

export interface SearchParamsCodec<Values extends object> {
  keys: readonly string[];
  defaults: Partial<Values>;
  parse: (source: SearchParamsLike) => Values;
  serialize: (values: Partial<Values>) => URLSearchParams;
  activeKeys: (values: Partial<Values>) => string[];
}

export function createSearchParamsCodec<Shape extends z.ZodRawShape>(
  shape: Shape,
  options: SearchParamsCodecOptions<z.output<z.ZodObject<Shape>>> = {},
): SearchParamsCodec<z.output<z.ZodObject<Shape>>> & { schema: z.ZodObject<Shape> } {
  const schema = z.object(shape);
  type Values = z.output<typeof schema>;
  const keys = Object.keys(shape);
  const defaults: Partial<Values> = options.defaults ?? {};

  function parse(source: SearchParamsLike): Values {
    return schema.parse(toRawSearchParams(source, keys));
  }

  function isDefault(key: string, value: unknown): boolean {
    const fallback: unknown = Reflect.get(defaults, key);
    return fallback !== undefined && sameValue(value, fallback);
  }

  function serialize(values: Partial<Values>): URLSearchParams {
    const params = new URLSearchParams();
    for (const key of keys) {
      const value: unknown = Reflect.get(values, key);
      if (!isDefault(key, value)) {
        appendValue(params, key, value);
      }
    }
    return params;
  }

  function isActive(key: string, value: unknown): boolean {
    if (value === undefined || value === null || value === "") {
      return false;
    }
    if (Array.isArray(value) && value.length === 0) {
      return false;
    }
    return !isDefault(key, value);
  }

  function activeKeys(values: Partial<Values>): string[] {
    return keys.filter((key) => isActive(key, Reflect.get(values, key)));
  }

  return { schema, keys, defaults, parse, serialize, activeKeys };
}

export type SearchParamsValues<Codec extends SearchParamsCodec<object>> = ReturnType<
  Codec["parse"]
>;
