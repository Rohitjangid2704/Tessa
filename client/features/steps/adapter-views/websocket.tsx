"use client";

import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyNote,
  FactList,
  StepNotice,
  Subsection,
} from "@/features/steps/components/step-section";
import { TruncatedText } from "@/features/steps/components/text-view";
import { formatCount, formatOffset } from "@/features/steps/format";
import type {
  WebsocketMessage,
  WebsocketStepRequest,
  WebsocketStepResponse,
} from "@/lib/api/types";
import { ExtraFields } from "./extra-fields";
import { hasKind, isListOf, isRecord } from "./guards";
import {
  describeCloseCode,
  isOrderlyClose,
  mergeTimeline,
  toTimelineEntries,
  type MessageDirection,
  type TimelineEntry,
} from "./websocket-timeline";

export const MESSAGE_PAGE_SIZE = 50;

const REQUEST_KEYS = ["kind", "url", "messages_sent"];
const RESPONSE_KEYS = ["kind", "messages_received", "close_code", "close_reason", "truncated"];

function isMessage(value: unknown): value is WebsocketMessage {
  return isRecord(value) && typeof value.at_ms === "number" && typeof value.data === "string";
}

export function isWebsocketRequest(value: unknown): value is WebsocketStepRequest {
  return (
    hasKind(value, "websocket") &&
    typeof value.url === "string" &&
    isListOf(value.messages_sent, isMessage)
  );
}

export function isWebsocketResponse(value: unknown): value is WebsocketStepResponse {
  return (
    hasKind(value, "websocket") &&
    typeof value.truncated === "boolean" &&
    isListOf(value.messages_received, isMessage)
  );
}

function DirectionLabel({ direction }: { direction: MessageDirection }) {
  const Icon = direction === "sent" ? ArrowUp : ArrowDown;
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {direction === "sent" ? "Sent" : "Received"}
    </span>
  );
}

function MessageTimeline({
  entries,
  emptyText,
}: {
  entries: readonly TimelineEntry[];
  emptyText: string;
}) {
  const [visible, setVisible] = useState(MESSAGE_PAGE_SIZE);

  if (entries.length === 0) {
    return <EmptyNote compact>{emptyText}</EmptyNote>;
  }

  const shown = entries.slice(0, visible);
  const hidden = entries.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <ol data-slot="websocket-messages" className="divide-y rounded-md border text-xs">
        {shown.map((entry, index) => (
          <li
            key={index}
            data-direction={entry.direction}
            className="flex flex-col gap-0.5 px-3 py-1.5 sm:grid sm:grid-cols-[5rem_6rem_minmax(0,1fr)] sm:gap-x-3"
          >
            <span className="tabular-nums text-muted-foreground">{formatOffset(entry.at_ms)}</span>
            <DirectionLabel direction={entry.direction} />
            <TruncatedText text={entry.data} className="font-mono" />
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setVisible((current) => current + MESSAGE_PAGE_SIZE)}
        >
          {`Show ${formatCount(Math.min(hidden, MESSAGE_PAGE_SIZE))} more of ${formatCount(hidden)} hidden messages`}
        </Button>
      ) : null}
    </div>
  );
}

function CloseSummary({ code, reason }: { code: number | null; reason: string | null }) {
  if (code === null) {
    return <>No close code was recorded.</>;
  }
  const orderly = isOrderlyClose(code);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={orderly ? "outline" : "destructive"}>
        {orderly ? null : <TriangleAlert aria-hidden="true" />}
        {`${code} ${describeCloseCode(code)}`}
      </Badge>
      {reason === null || reason === "" ? null : <span>{reason}</span>}
    </span>
  );
}

export function WebsocketRequestView({ request }: { request: WebsocketStepRequest }) {
  return (
    <div data-slot="websocket-request" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "URL", value: request.url, mono: true },
          { label: "Messages sent", value: formatCount(request.messages_sent.length) },
        ]}
      />
      <Subsection title="Messages sent">
        <MessageTimeline
          entries={toTimelineEntries(request.messages_sent, "sent")}
          emptyText="The scenario sent no messages."
        />
      </Subsection>
      <ExtraFields payload={request} knownKeys={REQUEST_KEYS} />
    </div>
  );
}

export function WebsocketResponseView({
  response,
  request,
}: {
  response: WebsocketStepResponse;
  request: WebsocketStepRequest | null;
}) {
  const sent = request === null ? [] : request.messages_sent;
  const timeline = mergeTimeline(sent, response.messages_received);
  return (
    <div data-slot="websocket-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          {
            label: "Closed with",
            value: (
              <CloseSummary
                code={response.close_code ?? null}
                reason={response.close_reason ?? null}
              />
            ),
          },
          { label: "Messages received", value: formatCount(response.messages_received.length) },
        ]}
      />
      {response.truncated ? (
        <StepNotice tone="warning" title="Messages truncated">
          The recorder stopped at its message cap, so later messages were not recorded. Do not read a
          missing message as a defect until you know the capture was complete.
        </StepNotice>
      ) : null}
      <Subsection title="Message timeline">
        <MessageTimeline
          entries={timeline}
          emptyText="No messages were sent or received during this step."
        />
      </Subsection>
      <ExtraFields payload={response} knownKeys={RESPONSE_KEYS} />
    </div>
  );
}
