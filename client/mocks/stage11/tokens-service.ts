import type { AuditVia } from "@/lib/api/types";
import { MockApiError, validationFailed } from "../factories/errors";
import { FieldValidator } from "../factories/validation";
import { PERSONAL_TOKEN_SUBJECT, TOKEN_CREATED, TOKEN_REVOKED } from "./audit-data";
import { auditStore } from "./audit-store";
import { TOKEN_LIMIT, TOKEN_NAME_MAX } from "./tokens-data";
import { tokensStore } from "./tokens-store";

export interface TokenCreateInput {
  name: string;
  expiresInDays: number;
}

export function parseTokenCreate(raw: Record<string, unknown>): TokenCreateInput {
  const validator = new FieldValidator("body");
  const name = validator.requiredString(raw, "name", { min: 1, max: TOKEN_NAME_MAX });
  const requestedDays = raw["expires_in_days"] === null ? undefined : raw["expires_in_days"];
  const expiresInDays = validator.integer(
    requestedDays === undefined ? {} : { expires_in_days: requestedDays },
    "expires_in_days",
    { min: 1, max: tokensStore.maxDays, fallback: tokensStore.maxDays },
  );
  if (validator.details.length > 0 || name === undefined || expiresInDays === undefined) {
    throw validationFailed(validator.details);
  }
  return { name: name.trim(), expiresInDays };
}

export function tokenLimitReached(): MockApiError {
  return new MockApiError(
    409,
    "token_limit",
    `You already have ${TOKEN_LIMIT} active personal tokens; revoke one before creating another`,
  );
}

export function assertBelowTokenLimit(userId: string): void {
  if (tokensStore.liveCount(userId) >= TOKEN_LIMIT) {
    throw tokenLimitReached();
  }
}

export function recordTokenCreated(
  actorUserId: string,
  tokenId: string,
  via: AuditVia,
  name: string,
): void {
  auditStore.record({
    action: TOKEN_CREATED,
    subjectType: PERSONAL_TOKEN_SUBJECT,
    subjectId: tokenId,
    actorUserId,
    via,
    detail: { name },
  });
}

export function recordTokenRevoked(
  actorUserId: string,
  tokenId: string,
  via: AuditVia,
  name: string,
): void {
  auditStore.record({
    action: TOKEN_REVOKED,
    subjectType: PERSONAL_TOKEN_SUBJECT,
    subjectId: tokenId,
    actorUserId,
    via,
    detail: { name },
  });
}
