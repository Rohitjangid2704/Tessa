"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonView } from "@/features/steps/components/json-view";
import {
  HeadersBlock,
  HttpStatusBadge,
  isPresent,
} from "@/features/steps/components/payload-blocks";
import { EmptyNote, FactList, Subsection } from "@/features/steps/components/step-section";
import { formatCount, formatOffset } from "@/features/steps/format";
import type {
  WebhookOutboundCall,
  WebhookSignature,
  WebhookStepRequest,
  WebhookStepResponse,
} from "@/lib/api/types";
import { ExtraFields } from "./extra-fields";
import { hasKind, isListOf, isRecord } from "./guards";

export const OUTBOUND_CALL_PAGE_SIZE = 20;

const REQUEST_KEYS = ["kind", "url", "headers", "body", "signature"];
const RESPONSE_KEYS = ["kind", "status", "headers", "body", "outbound_calls"];

const SIGNATURE_SCHEME_LABELS: Readonly<Partial<Record<string, string>>> = {
  hmac_sha256: "HMAC-SHA256",
};

function isOutboundCall(value: unknown): value is WebhookOutboundCall {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    typeof value.received_at_ms === "number" &&
    isRecord(value.headers)
  );
}

export function isWebhookRequest(value: unknown): value is WebhookStepRequest {
  return hasKind(value, "webhook") && typeof value.url === "string" && isRecord(value.headers);
}

export function isWebhookResponse(value: unknown): value is WebhookStepResponse {
  return (
    hasKind(value, "webhook") &&
    typeof value.status === "number" &&
    isRecord(value.headers) &&
    isListOf(value.outbound_calls, isOutboundCall)
  );
}

function describeScheme(scheme: string): string {
  return SIGNATURE_SCHEME_LABELS[scheme] ?? scheme;
}

function SignatureBlock({ signature }: { signature: WebhookSignature | null }) {
  return (
    <Subsection title="Signature">
      {signature === null ? (
        <EmptyNote compact>This webhook was sent without a signature.</EmptyNote>
      ) : (
        <FactList
          facts={[
            { label: "Scheme", value: describeScheme(signature.scheme) },
            { label: "Header", value: signature.header, mono: true },
            {
              label: "Payload hash (SHA-256)",
              value: (
                <span className="inline-flex flex-wrap items-center gap-1">
                  {signature.signed_payload_sha256}
                  <CopyButton
                    text={signature.signed_payload_sha256}
                    subject="payload hash"
                    variant="ghost"
                    size="xs"
                  />
                </span>
              ),
              mono: true,
            },
          ]}
        />
      )}
    </Subsection>
  );
}

function BodyBlock({ body, label }: { body: unknown; label: string }) {
  return (
    <Subsection title="Body">
      {isPresent(body) ? (
        <JsonView value={body} label={label} />
      ) : (
        <EmptyNote compact>There was no body.</EmptyNote>
      )}
    </Subsection>
  );
}

export function WebhookRequestView({ request }: { request: WebhookStepRequest }) {
  return (
    <div data-slot="webhook-request" className="flex flex-col gap-4">
      <FactList facts={[{ label: "URL", value: request.url, mono: true }]} />
      <SignatureBlock signature={request.signature ?? null} />
      <HeadersBlock headers={request.headers} />
      <BodyBlock body={request.body} label="Webhook body" />
      <ExtraFields payload={request} knownKeys={REQUEST_KEYS} />
    </div>
  );
}

function OutboundCallRow({ call }: { call: WebhookOutboundCall }) {
  return (
    <li>
      <details data-slot="outbound-call" className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5 text-xs marker:hidden focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-3 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          />
          <span className="tabular-nums text-muted-foreground">
            {formatOffset(call.received_at_ms)}
          </span>
          <Badge variant="outline" className="font-mono">
            {call.method}
          </Badge>
          <span className="min-w-0 font-mono wrap-anywhere">{call.url}</span>
        </summary>
        <div className="flex flex-col gap-3 border-t px-3 py-2">
          <HeadersBlock headers={call.headers} />
          <BodyBlock body={call.body} label="Outbound call body" />
        </div>
      </details>
    </li>
  );
}

function OutboundCalls({ calls }: { calls: readonly WebhookOutboundCall[] }) {
  const [visible, setVisible] = useState(OUTBOUND_CALL_PAGE_SIZE);

  if (calls.length === 0) {
    return (
      <EmptyNote compact>
        The app made no call to the stub receiver while this step ran.
      </EmptyNote>
    );
  }

  const shown = calls.slice(0, visible);
  const hidden = calls.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <ol data-slot="outbound-calls" className="divide-y rounded-md border">
        {shown.map((call, index) => (
          <OutboundCallRow key={index} call={call} />
        ))}
      </ol>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setVisible((current) => current + OUTBOUND_CALL_PAGE_SIZE)}
        >
          {`Show ${formatCount(Math.min(hidden, OUTBOUND_CALL_PAGE_SIZE))} more of ${formatCount(hidden)} hidden calls`}
        </Button>
      ) : null}
    </div>
  );
}

export function WebhookResponseView({ response }: { response: WebhookStepResponse }) {
  return (
    <div data-slot="webhook-response" className="flex flex-col gap-4">
      <FactList
        facts={[
          { label: "Status", value: <HttpStatusBadge status={response.status} /> },
          { label: "Outbound calls", value: formatCount(response.outbound_calls.length) },
        ]}
      />
      <HeadersBlock headers={response.headers} />
      <BodyBlock body={response.body} label="Webhook response body" />
      <Subsection title="Calls the stub receiver captured from the app">
        <OutboundCalls calls={response.outbound_calls} />
      </Subsection>
      <ExtraFields payload={response} knownKeys={RESPONSE_KEYS} />
    </div>
  );
}
