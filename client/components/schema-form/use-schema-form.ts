"use client";

import { useState } from "react";
import { changedKeys, createDraft, resolveDraft, type SchemaDraft } from "@/lib/schema/draft";
import { PARAMS_ERROR_SCOPE, serverFieldErrors, type ErrorScope } from "@/lib/schema/server-errors";
import type { JsonObject } from "@/lib/schema/subset";
import { FORM_ERROR_KEY, type FieldErrors } from "@/lib/schema/validate";

export interface UseSchemaFormOptions {
  schema: unknown;
  initialValue?: JsonObject;
  errorScope?: ErrorScope;
}

export interface SchemaFormController {
  draft: SchemaDraft;
  errors: FieldErrors;
  setDraft: (next: SchemaDraft) => void;
  submit: () => JsonObject | null;
  applyServerError: (error: unknown) => void;
  reset: (value?: JsonObject) => void;
}

const NO_SERVER_ERRORS: FieldErrors = {};

function belongsToAny(errorKey: string, keys: readonly string[]): boolean {
  return keys.some((key) => errorKey === key || (key !== "" && errorKey.startsWith(`${key}.`)));
}

function withoutKeys(errors: FieldErrors, keys: readonly string[]): FieldErrors {
  const remaining = Object.entries(errors).filter(([key]) => !belongsToAny(key, keys));
  return remaining.length === Object.keys(errors).length ? errors : Object.fromEntries(remaining);
}

export function useSchemaForm({
  schema,
  initialValue,
  errorScope = PARAMS_ERROR_SCOPE,
}: UseSchemaFormOptions): SchemaFormController {
  const [draft, setDraftState] = useState(() => createDraft(schema, initialValue));
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>(NO_SERVER_ERRORS);
  const resolved = resolveDraft(schema, draft);
  const errors: FieldErrors = { ...serverErrors, ...(submitted ? resolved.errors : {}) };

  function setDraft(next: SchemaDraft): void {
    const changed = changedKeys(draft, next);
    setDraftState(next);
    setServerErrors((previous) =>
      changed.includes(FORM_ERROR_KEY) ? NO_SERVER_ERRORS : withoutKeys(previous, changed),
    );
  }

  function submit(): JsonObject | null {
    setSubmitted(true);
    setServerErrors(NO_SERVER_ERRORS);
    return resolved.value;
  }

  function applyServerError(error: unknown): void {
    const { byField, general } = serverFieldErrors(error, errorScope);
    setServerErrors(
      general.length === 0 ? byField : { ...byField, [FORM_ERROR_KEY]: general.join(" ") },
    );
  }

  function reset(value?: JsonObject): void {
    setDraftState(createDraft(schema, value));
    setSubmitted(false);
    setServerErrors(NO_SERVER_ERRORS);
  }

  return { draft, errors, setDraft, submit, applyServerError, reset };
}
