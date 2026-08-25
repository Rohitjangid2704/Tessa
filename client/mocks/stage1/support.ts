import { createHash } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER } from "../config";
import { conflict, idempotencyKeyRequired, notFound, validationFailed } from "../factories/errors";
import { isUuid } from "../factories/ids";
import { FieldValidator } from "../factories/validation";
import type { MockUser } from "../types";
import { jsonResponse, pathParam, type ApiContext } from "../handlers/api";
import type { StageOneStore, TargetRecord } from "./store";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

export function stageOne(context: ApiContext): StageOneStore {
  return context.state.stageOne;
}

export function pathUuid(context: ApiContext, name: string): string {
  const value = pathParam(context, name);
  if (!isUuid(value)) {
    const validator = new FieldValidator("path");
    validator.requiredUuid({ [name]: value }, name);
    throw validationFailed(validator.details);
  }
  return value.toLowerCase();
}

export function requireTarget(context: ApiContext, targetId: string): TargetRecord {
  const target = stageOne(context).findTarget(targetId);
  if (target === undefined) {
    throw notFound("Target not found");
  }
  return target;
}

export function requireActiveTarget(context: ApiContext, targetId: string): TargetRecord {
  const target = requireTarget(context, targetId);
  if (target.archivedAt !== null) {
    throw conflict("conflict", "The target is archived");
  }
  return target;
}

export function requireIdempotencyKey(context: ApiContext): void {
  const key = context.request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw idempotencyKeyRequired();
  }
}

export function hashParts(...parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    digest.update(part).update("\n");
  }
  return digest.digest("hex");
}

export interface IdempotentOutcome {
  status: number;
  body: unknown;
}

export interface IdempotencyOptions {
  required: boolean;
  requestHash: string;
}

export async function withIdempotency(
  context: ApiContext,
  user: MockUser,
  options: IdempotencyOptions,
  execute: () => Promise<IdempotentOutcome> | IdempotentOutcome,
): Promise<Response> {
  const key = context.request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null && !options.required) {
    const outcome = await execute();
    return jsonResponse(outcome.body, { status: outcome.status });
  }
  if (key === null || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw idempotencyKeyRequired();
  }
  const storeKey = `${user.id}:${key}`;
  const stored = context.state.idempotency.get(storeKey);
  if (stored !== undefined) {
    if (stored.requestHash !== options.requestHash) {
      throw conflict(
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request",
      );
    }
    return jsonResponse(stored.body, {
      status: stored.status,
      headers: { "Idempotency-Replayed": "true" },
    });
  }
  const outcome = await execute();
  context.state.idempotency.set(storeKey, {
    requestHash: options.requestHash,
    status: outcome.status,
    body: outcome.body,
  });
  return jsonResponse(outcome.body, { status: outcome.status });
}
