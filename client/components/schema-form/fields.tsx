"use client";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  resolveWidget,
  UNSET_OPTION_VALUE,
  type SchemaFieldProps,
  type SchemaWidgets,
} from "./widgets";

export { UNSET_OPTION_VALUE, type SchemaFieldProps };

export interface SchemaFieldWithWidgetsProps extends SchemaFieldProps {
  widgets?: SchemaWidgets;
}

export function SchemaField({ widgets, ...props }: SchemaFieldWithWidgetsProps) {
  const { spec, id, error } = props;
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const describedBy =
    [spec.description === undefined ? null : descriptionId, error === undefined ? null : errorId]
      .filter((entry) => entry !== null)
      .join(" ") || undefined;
  const Widget = resolveWidget(spec, widgets);

  return (
    <Field data-slot="schema-field" data-field={spec.name} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        <span>{spec.label}</span>
        {spec.required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : (
          <span className="text-xs font-normal text-muted-foreground">optional</span>
        )}
      </FieldLabel>
      {spec.description === undefined ? null : (
        <FieldDescription id={descriptionId}>{spec.description}</FieldDescription>
      )}
      <Widget {...props} describedBy={describedBy} />
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  );
}
