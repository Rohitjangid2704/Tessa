import { Badge } from "@/components/ui/badge";
import { JsonView } from "@/features/steps/components/json-view";
import { HttpStatusBadge, isPresent } from "@/features/steps/components/payload-blocks";
import {
  EmptyNote,
  FactList,
  StepNotice,
  Subsection,
} from "@/features/steps/components/step-section";
import { TextView, TruncatedText } from "@/features/steps/components/text-view";
import { formatCount } from "@/features/steps/format";
import type { GraphqlError, GraphqlStepRequest, GraphqlStepResponse } from "@/lib/api/types";
import { ExtraFields } from "./extra-fields";
import { hasKind, isListOf, isRecord } from "./guards";

const REQUEST_KEYS = ["kind", "url", "operation_name", "query", "variables"];
const RESPONSE_KEYS = ["kind", "status", "data", "errors"];
const INDEX_SEGMENT = /^\d+$/;
const HTTP_ERROR_FLOOR = 400;

function isGraphqlError(value: unknown): value is GraphqlError {
  return isRecord(value) && typeof value.message === "string";
}

export function isGraphqlRequest(value: unknown): value is GraphqlStepRequest {
  return (
    hasKind(value, "graphql") && typeof value.url === "string" && typeof value.query === "string"
  );
}

export function isGraphqlResponse(value: unknown): value is GraphqlStepResponse {
  return (
    hasKind(value, "graphql") &&
    typeof value.status === "number" &&
    isListOf(value.errors, isGraphqlError)
  );
}

export function formatErrorPath(path: readonly string[]): string {
  return path.reduce(
    (formatted, segment) =>
      INDEX_SEGMENT.test(segment)
        ? `${formatted}[${segment}]`
        : formatted === ""
          ? segment
          : `${formatted}.${segment}`,
    "",
  );
}

function hasEntries(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

export function GraphqlRequestView({ request }: { request: GraphqlStepRequest }) {
  const variables = request.variables ?? null;
  return (
    <div data-slot="graphql-request" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "URL", value: request.url, mono: true },
          {
            label: "Operation",
            value: request.operation_name ?? "Anonymous operation",
            mono: request.operation_name !== null,
          },
        ]}
      />
      <TextView label="Query" text={request.query} />
      <Subsection title="Variables">
        {hasEntries(variables) ? (
          <JsonView value={variables} label="Request variables" />
        ) : (
          <EmptyNote compact>The operation was sent without variables.</EmptyNote>
        )}
      </Subsection>
      <ExtraFields payload={request} knownKeys={REQUEST_KEYS} />
    </div>
  );
}

function ErrorItem({ error }: { error: GraphqlError }) {
  const path = error.path ?? null;
  const extensions = error.extensions ?? null;
  return (
    <li data-slot="graphql-error" className="flex flex-col gap-1.5 px-3 py-2">
      <TruncatedText text={error.message} className="font-medium" />
      {path !== null && path.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Path <span className="font-mono">{formatErrorPath(path)}</span>
        </p>
      ) : null}
      {hasEntries(extensions) ? <JsonView value={extensions} label="Error extensions" /> : null}
    </li>
  );
}

function ErrorList({ errors }: { errors: readonly GraphqlError[] }) {
  if (errors.length === 0) {
    return <EmptyNote compact>The response carried no errors.</EmptyNote>;
  }
  return (
    <ol data-slot="graphql-errors" className="divide-y rounded-md border text-sm">
      {errors.map((error, index) => (
        <ErrorItem key={index} error={error} />
      ))}
    </ol>
  );
}

export function GraphqlResponseView({ response }: { response: GraphqlStepResponse }) {
  const errorCount = response.errors.length;
  return (
    <div data-slot="graphql-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "Status", value: <HttpStatusBadge status={response.status} /> },
          {
            label: "Errors",
            value:
              errorCount === 0 ? (
                "None"
              ) : (
                <Badge variant="destructive">{formatCount(errorCount)}</Badge>
              ),
          },
        ]}
      />
      {errorCount > 0 && response.status < HTTP_ERROR_FLOOR ? (
        <StepNotice tone="info" title="Errors came with a successful status">
          GraphQL reports errors in the response body, so a status below 400 does not mean the
          operation worked.
        </StepNotice>
      ) : null}
      <Subsection title="Data">
        {isPresent(response.data) ? (
          <JsonView value={response.data} label="Response data" />
        ) : (
          <EmptyNote compact>The response carried no data.</EmptyNote>
        )}
      </Subsection>
      <Subsection title="Errors">
        <ErrorList errors={response.errors} />
      </Subsection>
      <ExtraFields payload={response} knownKeys={RESPONSE_KEYS} />
    </div>
  );
}
