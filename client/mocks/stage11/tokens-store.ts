import type { PersonalToken } from "@/lib/api/types";
import { MockApiError, unauthenticated } from "../factories/errors";
import { mockState } from "../state";
import {
  buildRecord,
  isPersonalTokenSecret,
  seededRecords,
  TOKEN_MAX_DAYS,
  type TokenRecord,
  type TokensVariant,
} from "./tokens-data";

const DAY_MS = 86_400_000;

export type TokenState = "active" | "expired" | "revoked";

export function stateOf(token: PersonalToken, now: number): TokenState {
  if (token.revoked_at !== null) {
    return "revoked";
  }
  return Date.parse(token.expires_at) <= now ? "expired" : "active";
}

export class TokensStore {
  private records: TokenRecord[] = [];
  private variant: TokensVariant = "none";
  maxDays = TOKEN_MAX_DAYS;

  get currentVariant(): TokensVariant {
    return this.variant;
  }

  load(variant: TokensVariant): void {
    this.records = seededRecords(variant, Date.now());
    this.variant = variant;
  }

  listOf(userId: string): PersonalToken[] {
    return this.records
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record.token, state: stateOf(record.token, Date.now()) }))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  liveCount(userId: string, now: number = Date.now()): number {
    return this.records.filter(
      (record) => record.userId === userId && stateOf(record.token, now) === "active",
    ).length;
  }

  mint(userId: string, name: string, expiresInDays: number): TokenRecord {
    const now = Date.now();
    const record = buildRecord(userId, name, now, {
      expires_at: new Date(now + expiresInDays * DAY_MS).toISOString(),
    });
    this.records.push(record);
    return record;
  }

  find(userId: string, tokenId: string): TokenRecord | undefined {
    return this.records.find((record) => record.userId === userId && record.token.id === tokenId);
  }

  revoke(record: TokenRecord): boolean {
    if (record.token.revoked_at !== null) {
      return false;
    }
    record.token.revoked_at = new Date().toISOString();
    record.token.state = "revoked";
    return true;
  }

  resolveBearer(secret: string): string {
    if (!isPersonalTokenSecret(secret)) {
      throw unauthenticated("Invalid token");
    }
    const record = this.records.find((candidate) => candidate.secret === secret);
    if (record === undefined) {
      throw unauthenticated("Invalid token");
    }
    const state = stateOf(record.token, Date.now());
    if (state === "revoked") {
      throw new MockApiError(401, "token_revoked", "This personal token was revoked", [], {
        "WWW-Authenticate": "Bearer",
      });
    }
    if (state === "expired") {
      throw new MockApiError(401, "token_expired", "This personal token has expired", [], {
        "WWW-Authenticate": "Bearer",
      });
    }
    record.token.last_used_at = new Date().toISOString();
    return record.userId;
  }

  peekUserId(secret: string): string | undefined {
    return this.records.find((record) => record.secret === secret)?.userId;
  }

  secretOf(tokenId: string): string | undefined {
    return this.records.find((record) => record.token.id === tokenId)?.secret;
  }

  reset(): void {
    this.load("none");
    this.maxDays = TOKEN_MAX_DAYS;
  }
}

export const tokensStore = new TokensStore();

mockState.stageTwo.onReset(() => tokensStore.reset());
