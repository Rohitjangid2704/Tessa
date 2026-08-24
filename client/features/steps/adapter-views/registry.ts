import { createElement, type ComponentType, type ReactElement } from "react";
import { payloadKindOf } from "@/features/adapters/registry";
import { CliRequestView, CliResponseView, isCliRequest, isCliResponse } from "./cli";
import {
  GraphqlRequestView,
  GraphqlResponseView,
  isGraphqlRequest,
  isGraphqlResponse,
} from "./graphql";
import {
  PipelineRequestView,
  PipelineResponseView,
  isPipelineRequest,
  isPipelineResponse,
} from "./pipeline";
import {
  WebhookRequestView,
  WebhookResponseView,
  isWebhookRequest,
  isWebhookResponse,
} from "./webhook";
import {
  WebsocketRequestView,
  WebsocketResponseView,
  isWebsocketRequest,
  isWebsocketResponse,
} from "./websocket";

interface AdapterViewDefinition<RequestPayload, ResponsePayload> {
  isRequest: (payload: unknown) => payload is RequestPayload;
  isResponse: (payload: unknown) => payload is ResponsePayload;
  RequestView: ComponentType<{ request: RequestPayload }>;
  ResponseView: ComponentType<{ response: ResponsePayload; request: RequestPayload | null }>;
}

export interface AdapterView {
  renderRequest: (payload: unknown) => ReactElement | null;
  renderResponse: (payload: unknown, request: unknown) => ReactElement | null;
}

function defineAdapterView<RequestPayload, ResponsePayload>(
  definition: AdapterViewDefinition<RequestPayload, ResponsePayload>,
): AdapterView {
  return {
    renderRequest: (payload) =>
      definition.isRequest(payload)
        ? createElement(definition.RequestView, { request: payload })
        : null,
    renderResponse: (payload, request) =>
      definition.isResponse(payload)
        ? createElement(definition.ResponseView, {
            response: payload,
            request: definition.isRequest(request) ? request : null,
          })
        : null,
  };
}

const ADAPTER_VIEWS: ReadonlyMap<string, AdapterView> = new Map([
  [
    "webhook",
    defineAdapterView({
      isRequest: isWebhookRequest,
      isResponse: isWebhookResponse,
      RequestView: WebhookRequestView,
      ResponseView: WebhookResponseView,
    }),
  ],
  [
    "websocket",
    defineAdapterView({
      isRequest: isWebsocketRequest,
      isResponse: isWebsocketResponse,
      RequestView: WebsocketRequestView,
      ResponseView: WebsocketResponseView,
    }),
  ],
  [
    "graphql",
    defineAdapterView({
      isRequest: isGraphqlRequest,
      isResponse: isGraphqlResponse,
      RequestView: GraphqlRequestView,
      ResponseView: GraphqlResponseView,
    }),
  ],
  [
    "cli",
    defineAdapterView({
      isRequest: isCliRequest,
      isResponse: isCliResponse,
      RequestView: CliRequestView,
      ResponseView: CliResponseView,
    }),
  ],
  [
    "pipeline",
    defineAdapterView({
      isRequest: isPipelineRequest,
      isResponse: isPipelineResponse,
      RequestView: PipelineRequestView,
      ResponseView: PipelineResponseView,
    }),
  ],
]);

export const ADAPTER_VIEW_KINDS: readonly string[] = [...ADAPTER_VIEWS.keys()];

export function hasAdapterView(kind: string): boolean {
  return ADAPTER_VIEWS.has(kind);
}

export function renderAdapterRequest(payload: unknown): ReactElement | null {
  const kind = payloadKindOf(payload);
  if (kind === null) {
    return null;
  }
  return ADAPTER_VIEWS.get(kind)?.renderRequest(payload) ?? null;
}

export function renderAdapterResponse(payload: unknown, request: unknown): ReactElement | null {
  const kind = payloadKindOf(payload);
  if (kind === null) {
    return null;
  }
  return ADAPTER_VIEWS.get(kind)?.renderResponse(payload, request) ?? null;
}
