import { randomBytes } from "node:crypto";
import type { components } from "@/lib/api/schema";
import { newId } from "./ids";

type Schemas = components["schemas"];

export type Target = Schemas["Target"];
export type TargetSummary = Schemas["TargetSummary"];
export type TargetPage = Schemas["TargetPage"];
export type TargetCreate = Schemas["TargetCreate"];
export type TargetUpdate = Schemas["TargetUpdate"];

const SLUG_MAX_LENGTH = 60;
const SLUG_FALLBACK = "target";
const TOKEN_PREFIX = "tgt_";
const TOKEN_BODY_LENGTH = 22;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BITS_PER_BASE32_CHARACTER = 5;
const BITS_PER_BYTE = 8;

export const TARGET_TOKEN_PATTERN = /^tgt_[a-z2-7]{22}$/;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? SLUG_FALLBACK : slug;
}

export function newTargetToken(): string {
  let bits = 0;
  let buffer = 0;
  let body = "";
  for (const byte of randomBytes(14)) {
    buffer = (buffer << BITS_PER_BYTE) | byte;
    bits += BITS_PER_BYTE;
    while (bits >= BITS_PER_BASE32_CHARACTER) {
      bits -= BITS_PER_BASE32_CHARACTER;
      body += BASE32_ALPHABET[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return `${TOKEN_PREFIX}${body.slice(0, TOKEN_BODY_LENGTH)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildTarget(overrides: Partial<Target> = {}): Target {
  const name = overrides.name ?? "Gracie";
  return {
    id: newId(),
    name,
    slug: slugify(name),
    app_kind: "llm_assistant",
    tier: "qa",
    allow_production: false,
    target_token: newTargetToken(),
    hints: {},
    latest_bundle_id: null,
    created_at: nowIso(),
    archived_at: null,
    ...overrides,
  };
}

export function buildTargetSummary(overrides: Partial<TargetSummary> = {}): TargetSummary {
  const name = overrides.name ?? "Gracie";
  return {
    id: newId(),
    name,
    slug: slugify(name),
    app_kind: "llm_assistant",
    tier: "qa",
    latest_bundle_version: null,
    completeness_score: null,
    health: "unchecked",
    created_at: nowIso(),
    archived_at: null,
    ...overrides,
  };
}

export function buildTargetPage(
  items: readonly TargetSummary[],
  overrides: Partial<Omit<TargetPage, "items">> = {},
): TargetPage {
  return { items: [...items], next_cursor: null, total: null, ...overrides };
}
