import type { StepContent } from "../simulation/step-content";
import type {
  AdapterKind,
  AnyStepRequest,
  AnyStepResponse,
  CliStepRequest,
  CliStepResponse,
  GraphqlStepRequest,
  GraphqlStepResponse,
  PipelineStepRequest,
  PipelineStepResponse,
  Tier0Failure,
  Tier0Result,
  WebhookStepRequest,
  WebhookStepResponse,
  WebsocketStepRequest,
  WebsocketStepResponse,
} from "@/lib/api/types";

export interface AdapterStepOptions {
  label: string;
  latencyMs: number;
  ok?: boolean;
  responseTruncated?: boolean;
  tier0?: Tier0Result;
}

const PASSED: Tier0Result = { passed: true, failures: [] };

export function adapterTier0Failed(failures: Tier0Failure[]): Tier0Result {
  return { passed: false, failures };
}

export function adapterStep(
  adapter: AdapterKind,
  request: AnyStepRequest | null,
  response: AnyStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return {
    adapter,
    label: options.label,
    request,
    response,
    response_truncated: options.responseTruncated ?? false,
    payload_purged: false,
    ask: null,
    answer: null,
    tools: [],
    cards: [],
    latency_ms: options.latencyMs,
    cost_usd: 0,
    tier0: options.tier0 ?? PASSED,
    ok: options.ok ?? true,
    artifacts: [],
    verdict: null,
  };
}

export function webhookStep(
  request: WebhookStepRequest | null,
  response: WebhookStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return adapterStep("webhook", request, response, options);
}

export function websocketStep(
  request: WebsocketStepRequest | null,
  response: WebsocketStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return adapterStep("websocket", request, response, options);
}

export function graphqlStep(
  request: GraphqlStepRequest | null,
  response: GraphqlStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return adapterStep("graphql", request, response, options);
}

export function cliStep(
  request: CliStepRequest | null,
  response: CliStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return adapterStep("cli", request, response, options);
}

export function pipelineStep(
  request: PipelineStepRequest | null,
  response: PipelineStepResponse | null,
  options: AdapterStepOptions,
): StepContent {
  return adapterStep("http", request, response, options);
}

export function wirePayload<Payload extends AnyStepRequest | AnyStepResponse>(
  fields: Record<string, unknown>,
): Payload {
  return JSON.parse(JSON.stringify(fields));
}
