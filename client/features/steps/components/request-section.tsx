import { Badge } from "@/components/ui/badge";
import { renderAdapterRequest } from "@/features/steps/adapter-views/registry";
import type {
  AnyStepRequest,
  BrowserStepRequest,
  HttpStepRequest,
  SseStepRequest,
  Step,
} from "@/lib/api/types";
import { JsonView } from "./json-view";
import { HeadersBlock, isPresent, UnknownPayload } from "./payload-blocks";
import {
  EmptyNote,
  FactList,
  StepNotice,
  StepSection,
  Subsection,
  type Fact,
} from "./step-section";
import { TextView } from "./text-view";

function HttpRequestDetails({ request }: { request: HttpStepRequest | SseStepRequest }) {
  const hasQuery = request.query !== null && Object.keys(request.query).length > 0;
  return (
    <div data-slot="http-request" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "Method", value: request.method, mono: true },
          { label: "URL", value: request.url, mono: true },
        ]}
      />
      {hasQuery ? (
        <Subsection title="Query">
          <JsonView value={request.query} label="Request query" />
        </Subsection>
      ) : null}
      <HeadersBlock headers={request.headers} />
      <Subsection title="Body">
        {isPresent(request.body) ? (
          <JsonView value={request.body} label="Request body" />
        ) : (
          <EmptyNote compact>This request had no body.</EmptyNote>
        )}
      </Subsection>
    </div>
  );
}

function BrowserRequestDetails({ request }: { request: BrowserStepRequest }) {
  const facts: Fact[] = [
    { label: "Action", value: <Badge variant="outline">{request.action}</Badge> },
  ];
  if (request.target !== null) {
    facts.push({ label: "Target", value: request.target, mono: true });
  }
  if (request.text !== null) {
    facts.push({ label: "Text", value: request.text, mono: true });
  }
  if (request.url !== null) {
    facts.push({ label: "URL", value: request.url, mono: true });
  }
  return (
    <div data-slot="browser-request">
      <FactList facts={facts} />
    </div>
  );
}

function RequestDetails({ request }: { request: AnyStepRequest }) {
  switch (request.kind) {
    case "http":
    case "sse":
      return <HttpRequestDetails request={request} />;
    case "browser":
      return <BrowserRequestDetails request={request} />;
    default:
      return renderAdapterRequest(request) ?? <UnknownPayload title="Request" payload={request} />;
  }
}

export function RequestSection({ step }: { step: Step }) {
  const { request, ask, payload_purged: purged } = step;
  return (
    <StepSection title="Request">
      {purged ? (
        <StepNotice tone="info" title="Payload purged by retention">
          The stored request was removed after the retention period. The summary, verdict and
          artifacts of this step are still available.
        </StepNotice>
      ) : null}
      {ask !== null ? <TextView label="Ask" text={ask} /> : null}
      {request !== null ? <RequestDetails request={request} /> : null}
      {request === null && ask === null && !purged ? (
        <EmptyNote>No request was recorded for this step.</EmptyNote>
      ) : null}
    </StepSection>
  );
}
