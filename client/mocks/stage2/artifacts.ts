import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "@/lib/api/types";
import type { ArtifactDef, MediaFixture } from "./types";

export const MEDIA_URL_TTL_SECONDS = 900;
export const ARTIFACT_PATH_PREFIX = "/api/v1/artifacts/";

const MEDIA_DIRECTORY = join(process.cwd(), "mocks", "fixtures", "media");
const MEDIA_FILES: Readonly<Record<MediaFixture, string>> = {
  png: "screenshot.png",
  webm: "recording.webm",
  zip: "trace.zip",
};
const EXPIRED_BY_SECONDS = 60;
const MILLISECONDS_PER_SECOND = 1000;

const mediaCache = new Map<MediaFixture, Buffer>();

export function mediaBytes(fixture: MediaFixture): Buffer {
  const cached = mediaCache.get(fixture);
  if (cached !== undefined) {
    return cached;
  }
  const loaded = readFileSync(join(MEDIA_DIRECTORY, MEDIA_FILES[fixture]));
  mediaCache.set(fixture, loaded);
  return loaded;
}

export interface ArtifactTokenClaims {
  artifactId: string;
  expiresAtSeconds: number;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintArtifactToken(artifactId: string, expiresAtSeconds: number, key: string) {
  const payload = Buffer.from(JSON.stringify({ a: artifactId, e: expiresAtSeconds })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, key)}`;
}

export type TokenVerdict =
  { ok: true; claims: ArtifactTokenClaims } | { ok: false; reason: "invalid" | "expired" };

export function verifyArtifactToken(token: string, key: string, nowMs: number): TokenVerdict {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return { ok: false, reason: "invalid" };
  }
  const payload = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(payload, key));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const artifactId: unknown = Reflect.get(Object(parsed), "a");
    const expiresAt: unknown = Reflect.get(Object(parsed), "e");
    if (typeof artifactId !== "string" || typeof expiresAt !== "number") {
      return { ok: false, reason: "invalid" };
    }
    if (expiresAt * MILLISECONDS_PER_SECOND <= nowMs) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, claims: { artifactId, expiresAtSeconds: expiresAt } };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export interface MintOptions {
  key: string;
  nowMs: number;
  expired: boolean;
}

export function mintArtifactRef(def: ArtifactDef, options: MintOptions): ArtifactRef {
  const nowSeconds = Math.floor(options.nowMs / MILLISECONDS_PER_SECOND);
  const expiresAtSeconds = options.expired
    ? nowSeconds - EXPIRED_BY_SECONDS
    : nowSeconds + MEDIA_URL_TTL_SECONDS;
  return {
    id: def.id,
    kind: def.kind,
    mime: def.mime,
    size_bytes: mediaBytes(def.fixture).length,
    url: `${ARTIFACT_PATH_PREFIX}${mintArtifactToken(def.id, expiresAtSeconds, options.key)}`,
    expires_at: new Date(expiresAtSeconds * MILLISECONDS_PER_SECOND).toISOString(),
  };
}

export interface ByteRange {
  start: number;
  end: number;
}

export function parseRange(header: string | null, size: number): ByteRange | "invalid" | null {
  if (header === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return null;
  }
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "invalid" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return start >= size || end < start ? "invalid" : { start, end };
}

export function fileNameOf(def: ArtifactDef): string {
  const extension = MEDIA_FILES[def.fixture].split(".").at(-1) ?? "bin";
  return `${def.kind}-${def.id.slice(-8)}.${extension}`;
}
