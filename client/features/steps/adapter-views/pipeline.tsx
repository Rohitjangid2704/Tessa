import { CircleCheck, CircleX } from "lucide-react";
import { differingFields } from "@/components/json-diff";
import { Badge } from "@/components/ui/badge";
import { JsonView } from "@/features/steps/components/json-view";
import {
  EmptyNote,
  FactList,
  Subsection,
  type Fact,
} from "@/features/steps/components/step-section";
import type { PipelineStepRequest, PipelineStepResponse } from "@/lib/api/types";
import { ExtraFields } from "./extra-fields";
import { hasKind, isRecord, type UnknownRecord } from "./guards";

const REQUEST_KEYS = ["kind", "op", "marker", "role", "params"];
const RESPONSE_KEYS = ["kind", "op", "ok", "expected", "observed"];

const OPERATION_LABELS: Readonly<Partial<Record<string, string>>> = {
  ingest: "Ingest fixture",
  assert_index: "Assert index state",
  assert_visibility: "Assert visibility",
};

export function isPipelineRequest(value: unknown): value is PipelineStepRequest {
  return (
    hasKind(value, "pipeline") &&
    typeof value.op === "string" &&
    typeof value.marker === "string" &&
    isRecord(value.params)
  );
}

export function isPipelineResponse(value: unknown): value is PipelineStepResponse {
  return (
    hasKind(value, "pipeline") && typeof value.op === "string" && typeof value.ok === "boolean"
  );
}

export function describePipelineOperation(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation;
}

function describeOutcome(operation: string, ok: boolean): string {
  if (operation === "ingest") {
    return ok ? "Ingested" : "Ingest failed";
  }
  return ok ? "Assertion held" : "Assertion did not hold";
}

export function PipelineRequestView({ request }: { request: PipelineStepRequest }) {
  const facts: Fact[] = [
    {
      label: "Operation",
      value: <Badge variant="outline">{describePipelineOperation(request.op)}</Badge>,
    },
    { label: "Marker", value: request.marker, mono: true },
  ];
  if (request.role !== null && request.role !== undefined) {
    facts.push({ label: "Role", value: request.role, mono: true });
  }
  return (
    <div data-slot="pipeline-request" className="flex flex-col gap-4">
      <FactList facts={facts} />
      <Subsection title="Parameters">
        {Object.keys(request.params).length === 0 ? (
          <EmptyNote compact>The operation had no parameters.</EmptyNote>
        ) : (
          <JsonView value={request.params} label="Pipeline parameters" />
        )}
      </Subsection>
      <ExtraFields payload={request} knownKeys={REQUEST_KEYS} />
    </div>
  );
}

function OutcomeBadge({ operation, ok }: { operation: string; ok: boolean }) {
  const Icon = ok ? CircleCheck : CircleX;
  return (
    <Badge variant={ok ? "outline" : "destructive"}>
      <Icon aria-hidden="true" />
      {describeOutcome(operation, ok)}
    </Badge>
  );
}

function ValueBlock({ label, value }: { label: string; value: UnknownRecord | null }) {
  if (value === null) {
    return (
      <Subsection title={label}>
        <EmptyNote compact>Nothing was recorded.</EmptyNote>
      </Subsection>
    );
  }
  return <JsonView value={value} label={label} />;
}

function describeDifference(
  expected: UnknownRecord | null,
  observed: UnknownRecord | null,
): string | null {
  if (expected === null || observed === null) {
    return null;
  }
  const names = differingFields(expected, observed);
  return names.length === 0
    ? "Expected and observed hold the same values."
    : `Fields that differ: ${names.join(", ")}.`;
}

export function PipelineResponseView({ response }: { response: PipelineStepResponse }) {
  const expected = response.expected ?? null;
  const observed = response.observed ?? null;
  const difference = describeDifference(expected, observed);
  return (
    <div data-slot="pipeline-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          {
            label: "Operation",
            value: <Badge variant="outline">{describePipelineOperation(response.op)}</Badge>,
          },
          { label: "Outcome", value: <OutcomeBadge operation={response.op} ok={response.ok} /> },
        ]}
      />
      <Subsection title="Expected against observed">
        <div className="grid gap-3 md:grid-cols-2">
          <ValueBlock label="Expected" value={expected} />
          <ValueBlock label="Observed" value={observed} />
        </div>
        {difference === null ? null : (
          <p data-slot="pipeline-difference" className="text-sm text-muted-foreground">
            {difference}
          </p>
        )}
      </Subsection>
      <ExtraFields payload={response} knownKeys={RESPONSE_KEYS} />
    </div>
  );
}
