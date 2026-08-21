"use client";

import { Info } from "lucide-react";
import { useId } from "react";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { draftWithRaw, draftWithValue, type SchemaDraft } from "@/lib/schema/draft";
import { analyzeSchema, type FieldSpec } from "@/lib/schema/subset";
import { FORM_ERROR_KEY, type FieldErrors } from "@/lib/schema/validate";
import { cn } from "@/lib/utils";
import { SchemaField } from "./fields";
import type { SchemaWidgets } from "./widgets";

export interface SchemaFormProps {
  schema: unknown;
  draft: SchemaDraft;
  onDraftChange: (draft: SchemaDraft) => void;
  errors?: FieldErrors;
  disabled?: boolean;
  legend?: string;
  rawLabel?: string;
  widgets?: SchemaWidgets;
  className?: string;
}

const NO_ERRORS: FieldErrors = {};

function describeError(key: string, message: string): string {
  return key === FORM_ERROR_KEY ? message : `${key}: ${message}`;
}

function isNestedKey(key: string, fieldName: string): boolean {
  return key.startsWith(`${fieldName}.`);
}

export function fieldErrorOf(errors: FieldErrors, fieldName: string): string | undefined {
  const direct = errors[fieldName];
  if (direct !== undefined) {
    return direct;
  }
  const nested = Object.entries(errors).filter(([key]) => isNestedKey(key, fieldName));
  if (nested.length === 0) {
    return undefined;
  }
  return nested
    .map(([key, message]) => {
      const position = key.slice(fieldName.length + 1);
      return /^\d+$/.test(position) ? `Item ${Number(position) + 1}: ${message}` : message;
    })
    .join(". ");
}

interface FieldSection {
  title: string | null;
  fields: FieldSpec[];
}

export function sectionsOf(fields: readonly FieldSpec[]): FieldSection[] {
  const sections: FieldSection[] = [];
  for (const spec of fields) {
    const title = spec.ui.group ?? null;
    const existing = sections.find((section) => section.title === title);
    if (existing === undefined) {
      sections.push({ title, fields: [spec] });
    } else {
      existing.fields.push(spec);
    }
  }
  return sections;
}

interface RawJsonFieldProps {
  id: string;
  reason: string;
  label: string;
  draft: SchemaDraft;
  errors: FieldErrors;
  disabled: boolean;
  onDraftChange: (draft: SchemaDraft) => void;
}

function RawJsonField({
  id,
  reason,
  label,
  draft,
  errors,
  disabled,
  onDraftChange,
}: RawJsonFieldProps) {
  const noticeId = `${id}-notice`;
  const errorId = `${id}-errors`;
  const messages = Object.entries(errors).map(([key, message]) => describeError(key, message));
  return (
    <div data-slot="schema-form-fallback" className="flex flex-col gap-3">
      <div
        id={noticeId}
        role="note"
        className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      >
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p>
          <span className="font-medium">Edit as JSON.</span> {reason} The form cannot show this
          schema, so type the parameters as a JSON object. The server checks them again.
        </p>
      </div>
      <Field data-invalid={messages.length > 0 ? true : undefined}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Textarea
          id={id}
          name="params-json"
          value={draft.raw}
          disabled={disabled}
          rows={8}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          aria-invalid={messages.length > 0}
          aria-describedby={[noticeId, messages.length > 0 ? errorId : null]
            .filter((entry) => entry !== null)
            .join(" ")}
          onChange={(event) => onDraftChange(draftWithRaw(draft, event.target.value))}
        />
        {messages.length > 0 ? (
          <ul
            id={errorId}
            role="alert"
            className="flex list-disc flex-col gap-1 pl-4 text-sm text-destructive"
          >
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </Field>
    </div>
  );
}

export function SchemaForm({
  schema,
  draft,
  onDraftChange,
  errors = NO_ERRORS,
  disabled = false,
  legend,
  rawLabel = "Parameters (JSON)",
  widgets,
  className,
}: SchemaFormProps) {
  const baseId = useId();
  const plan = analyzeSchema(schema);

  if (plan.mode === "empty") {
    return (
      <p data-slot="schema-form-empty" className={cn("text-sm text-muted-foreground", className)}>
        This takes no parameters.
      </p>
    );
  }

  if (plan.mode === "raw") {
    return (
      <div data-slot="schema-form" data-mode="raw" className={className}>
        <RawJsonField
          id={`${baseId}-raw`}
          reason={plan.reason}
          label={rawLabel}
          draft={draft}
          errors={errors}
          disabled={disabled}
          onDraftChange={onDraftChange}
        />
      </div>
    );
  }

  const fieldNames = plan.fields.map((spec) => spec.name);
  const generalMessages = Object.entries(errors)
    .filter(
      ([key]) =>
        key === FORM_ERROR_KEY ||
        !fieldNames.some((name) => key === name || isNestedKey(key, name)),
    )
    .map(([key, message]) => describeError(key, message));
  const sections = sectionsOf(plan.fields);

  function renderFields(fields: readonly FieldSpec[]) {
    return (
      <FieldGroup>
        {fields.map((spec) => (
          <SchemaField
            key={spec.name}
            spec={spec}
            id={`${baseId}-${spec.name}`}
            value={draft.values[spec.name] ?? ""}
            error={fieldErrorOf(errors, spec.name)}
            disabled={disabled}
            widgets={widgets}
            onChange={(text) => onDraftChange(draftWithValue(draft, spec.name, text))}
          />
        ))}
      </FieldGroup>
    );
  }

  return (
    <FieldSet data-slot="schema-form" data-mode="fields" disabled={disabled} className={className}>
      {legend === undefined ? null : <FieldLegend variant="label">{legend}</FieldLegend>}
      {sections.map((section) =>
        section.title === null ? (
          <div key="ungrouped" data-slot="schema-form-section">
            {renderFields(section.fields)}
          </div>
        ) : (
          <FieldSet key={section.title} data-slot="schema-form-group">
            <FieldLegend variant="label">{section.title}</FieldLegend>
            {renderFields(section.fields)}
          </FieldSet>
        ),
      )}
      {generalMessages.length === 0 ? null : (
        <ul
          data-slot="schema-form-errors"
          role="alert"
          className="flex list-disc flex-col gap-1 pl-4 text-sm text-destructive"
        >
          {generalMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </FieldSet>
  );
}
