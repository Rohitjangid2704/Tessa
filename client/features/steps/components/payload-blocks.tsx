import { Badge } from "@/components/ui/badge";
import { describeHttpStatusClass, isHttpErrorStatus } from "@/features/steps/format";
import { JsonView } from "./json-view";
import { EmptyNote, FactList, StepNotice, Subsection } from "./step-section";

export function describeKind(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    typeof payload.kind === "string"
  ) {
    return payload.kind;
  }
  return "unknown";
}

export function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export function HeadersBlock({ headers }: { headers: Readonly<Record<string, string>> }) {
  const entries = Object.entries(headers);
  return (
    <Subsection title="Headers">
      {entries.length === 0 ? (
        <EmptyNote compact>No headers were recorded.</EmptyNote>
      ) : (
        <FactList
          keys="code"
          facts={entries.map(([name, value]) => ({ label: name, value: String(value), mono: true }))}
        />
      )}
    </Subsection>
  );
}

export function HttpStatusBadge({ status }: { status: number }) {
  const statusClass = describeHttpStatusClass(status);
  return (
    <Badge variant={isHttpErrorStatus(status) ? "destructive" : "outline"}>
      {statusClass === null ? String(status) : `${status} ${statusClass}`}
    </Badge>
  );
}

export function UnknownPayload({ title, payload }: { title: string; payload: unknown }) {
  return (
    <div data-slot="unknown-payload" className="flex flex-col gap-2">
      <StepNotice
        tone="info"
        title={`Unrecognised ${title.toLowerCase()} kind: ${describeKind(payload)}`}
      >
        This kind has no dedicated view yet, so the raw JSON is shown.
      </StepNotice>
      <JsonView value={payload} label={title} />
    </div>
  );
}
