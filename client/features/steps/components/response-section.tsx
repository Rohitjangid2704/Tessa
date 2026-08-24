import { TriangleAlert } from "lucide-react";
import { renderAdapterResponse } from "@/features/steps/adapter-views/registry";
import { describeSseClosedBy, formatCount } from "@/features/steps/format";
import type {
  AnyStepRequest,
  AnyStepResponse,
  HttpStepResponse,
  SseStepResponse,
  Step,
} from "@/lib/api/types";
import { BrowserResponseDetails } from "./browser-response";
import { JsonView } from "./json-view";
import { HeadersBlock, HttpStatusBadge, isPresent, UnknownPayload } from "./payload-blocks";
import { SseEventList } from "./sse-event-list";
import { EmptyNote, FactList, StepNotice, StepSection, Subsection } from "./step-section";
import { TextView } from "./text-view";

function HttpBody({ body, bodyText }: { body: unknown; bodyText: string | null }) {
  if (isPresent(body)) {
    return <JsonView value={body} label="Response body" />;
  }
  if (bodyText !== null) {
    return <TextView label="Response body (text)" text={bodyText} />;
  }
  return <EmptyNote compact>The response had no body.</EmptyNote>;
}

function HttpResponseDetails({ response }: { response: HttpStepResponse }) {
  return (
    <div data-slot="http-response" className="flex flex-col gap-4">
      <FactList facts={[{ label: "Status", value: <HttpStatusBadge status={response.status} /> }]} />
      <HeadersBlock headers={response.headers} />
      <Subsection title="Body">
        <HttpBody body={response.body} bodyText={response.body_text} />
      </Subsection>
    </div>
  );
}

function ClosedBy({ closedBy }: { closedBy: SseStepResponse["closed_by"] }) {
  if (closedBy === "server") {
    return <>{describeSseClosedBy(closedBy)}</>;
  }
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {describeSseClosedBy(closedBy)}
    </span>
  );
}

function SseResponseDetails({ response }: { response: SseStepResponse }) {
  return (
    <div data-slot="sse-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "Status", value: <HttpStatusBadge status={response.status} /> },
          { label: "Ended", value: <ClosedBy closedBy={response.closed_by} /> },
          { label: "Events", value: formatCount(response.events.length) },
        ]}
      />
      <Subsection title="Events in arrival order">
        <SseEventList events={response.events} />
      </Subsection>
    </div>
  );
}

interface ResponseDetailsProps {
  response: AnyStepResponse;
  request: AnyStepRequest | null;
}

function ResponseDetails({ response, request }: ResponseDetailsProps) {
  switch (response.kind) {
    case "http":
      return <HttpResponseDetails response={response} />;
    case "sse":
      return <SseResponseDetails response={response} />;
    case "browser":
      return <BrowserResponseDetails response={response} />;
    default:
      return (
        renderAdapterResponse(response, request) ?? (
          <UnknownPayload title="Response" payload={response} />
        )
      );
  }
}

export function ResponseSection({ step }: { step: Step }) {
  const { request, response, answer, payload_purged: purged, response_truncated: truncated } = step;
  return (
    <StepSection title="Response">
      {purged ? (
        <StepNotice tone="info" title="Payload purged by retention">
          The stored response was removed after the retention period. The summary, verdict and
          artifacts of this step are still available.
        </StepNotice>
      ) : null}
      {truncated ? (
        <StepNotice tone="warning" title="Response truncated">
          The stored response was cut at the storage limit, so its end is missing. Do not read a
          missing field as a defect until you know the payload was complete.
        </StepNotice>
      ) : null}
      {answer !== null ? <TextView label="Answer" text={answer} /> : null}
      {response !== null ? <ResponseDetails response={response} request={request} /> : null}
      {response === null && answer === null && !purged ? (
        <EmptyNote>No response was recorded for this step.</EmptyNote>
      ) : null}
    </StepSection>
  );
}
