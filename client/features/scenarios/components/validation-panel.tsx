"use client";

import { Info, TriangleAlert } from "lucide-react";
import { useId, useMemo } from "react";
import { createPointerResolver, describeIssueLocation } from "@/components/editor/markers";
import type { EditorMarker, EditorSchemaState } from "@/components/editor/editor-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { pluralize } from "@/features/bundles/format";
import { describeApiError } from "@/lib/api/errors";
import type { ScenarioIssue } from "@/lib/api/types";
import type { ScenarioValidationState } from "../use-scenario-validation";

export function IssueItems({ issues, yaml }: { issues: readonly ScenarioIssue[]; yaml: string }) {
  const resolve = useMemo(() => createPointerResolver(yaml), [yaml]);
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue, index) => {
        const location = describeIssueLocation(issue, resolve);
        return (
          <li
            key={`${issue.code}-${issue.pointer ?? ""}-${index}`}
            className="flex flex-col gap-0.5"
          >
            <span className="font-medium wrap-break-word">{issue.message}</span>
            <span className="text-xs wrap-break-word">
              <code className="font-mono">{issue.code}</code>
              {issue.pointer === null || issue.pointer === "" ? null : (
                <>
                  {" at "}
                  <code className="font-mono">{issue.pointer}</code>
                </>
              )}
              {location === null ? null : `, ${location}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function IssueAlerts({
  errors,
  warnings,
  yaml,
}: {
  errors: readonly ScenarioIssue[];
  warnings: readonly ScenarioIssue[];
  yaml: string;
}) {
  return (
    <>
      {errors.length > 0 ? (
        <Alert variant="destructive" data-slot="scenario-validation-errors">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{pluralize(errors.length, "error")} to fix</AlertTitle>
          <AlertDescription>
            <IssueItems issues={errors} yaml={yaml} />
          </AlertDescription>
        </Alert>
      ) : null}
      {warnings.length > 0 ? (
        <Alert role="note" data-slot="scenario-validation-warnings">
          <Info aria-hidden="true" />
          <AlertTitle>{pluralize(warnings.length, "warning")}</AlertTitle>
          <AlertDescription>
            <IssueItems issues={warnings} yaml={yaml} />
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function SchemaProblems({ markers }: { markers: readonly EditorMarker[] }) {
  const errors = markers.filter((marker) => marker.severity === "error");
  const others = markers.filter((marker) => marker.severity !== "error");
  if (markers.length === 0) {
    return null;
  }
  return (
    <>
      {errors.length > 0 ? (
        <Alert variant="destructive" data-slot="scenario-schema-errors">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>
            {pluralize(errors.length, "schema error")}, saving is blocked until fixed
          </AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {errors.map((marker) => (
                <li key={`${marker.line}:${marker.column}:${marker.message}`}>
                  <span className="font-mono text-xs">
                    line {marker.line}, column {marker.column}
                  </span>{" "}
                  <span className="wrap-break-word">{marker.message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {others.length > 0 ? (
        <Alert role="note" data-slot="scenario-schema-warnings">
          <Info aria-hidden="true" />
          <AlertTitle>{pluralize(others.length, "schema warning")}</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {others.map((marker) => (
                <li key={`${marker.line}:${marker.column}:${marker.message}`}>
                  <span className="font-mono text-xs">
                    line {marker.line}, column {marker.column}
                  </span>{" "}
                  <span className="wrap-break-word">{marker.message}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

export type ValidationPanelProps = {
  yaml: string;
  schemaMarkers: readonly EditorMarker[];
  schemaState: EditorSchemaState;
  server: ScenarioValidationState;
};

function describeProgress(props: ValidationPanelProps): string {
  const schemaErrors = props.schemaMarkers.filter((marker) => marker.severity === "error").length;
  const { status, validation } = props.server;
  if (status === "checking") {
    return "Checking with the server";
  }
  if (validation === null) {
    return schemaErrors > 0
      ? `${pluralize(schemaErrors, "schema error")}`
      : "No schema problems found";
  }
  const errors = validation.errors.length + schemaErrors;
  const warnings = validation.warnings.length;
  if (errors === 0 && warnings === 0) {
    return "No problems found";
  }
  return `${pluralize(errors, "error")}, ${pluralize(warnings, "warning")}`;
}

export function ValidationPanel(props: ValidationPanelProps) {
  const headingId = useId();
  const { yaml, schemaMarkers, schemaState, server } = props;
  const { validation } = server;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="validation-panel"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Validation
        </h2>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {describeProgress(props)}
        </p>
      </div>
      {schemaState === "error" ? (
        <Alert role="note" data-slot="scenario-schema-offline">
          <Info aria-hidden="true" />
          <AlertTitle>The schema could not be loaded</AlertTitle>
          <AlertDescription>
            Editor hints are off. Only the checks of the server apply until the schema loads again.
          </AlertDescription>
        </Alert>
      ) : null}
      {server.status === "unavailable" ? (
        <Alert role="note" data-slot="scenario-server-offline">
          <Info aria-hidden="true" />
          <AlertTitle>Server validation is not available</AlertTitle>
          <AlertDescription>
            {describeApiError(server.error)} The schema checks in the editor still work, and
            saving still validates on the server.
          </AlertDescription>
        </Alert>
      ) : null}
      <SchemaProblems markers={schemaMarkers} />
      {validation === null ? null : (
        <IssueAlerts errors={validation.errors} warnings={validation.warnings} yaml={yaml} />
      )}
    </section>
  );
}
