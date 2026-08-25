import type { components } from "@/lib/api/schema";

type Schemas = components["schemas"];

export type AuthUser = Schemas["AuthUser"];
export type CredentialsVerifyRequest = Schemas["CredentialsVerifyRequest"];
export type DependencyCheck = Schemas["DependencyCheck"];
export type DependencyHealth = Schemas["DependencyHealth"];
export type DependencyStatus = Schemas["DependencyStatus"];
export type ErrorBody = Schemas["ErrorBody"];
export type ErrorDetail = Schemas["ErrorDetail"];
export type ErrorResponse = Schemas["ErrorResponse"];
export type HealthStatus = Schemas["HealthStatus"];
export type HelloRunCreate = Schemas["HelloRunCreate"];
export type RootInfo = Schemas["RootInfo"];
export type RunCounters = Schemas["RunCounters"];
export type RunEvent = Schemas["RunEvent"];
export type RunEventPage = Schemas["RunEventPage"];
export type RunHandle = Schemas["RunHandle"];
export type RunStatus = Schemas["RunStatus"];
export type SchemaIndex = Schemas["SchemaIndex"];
export type SchemaIndexEntry = Schemas["SchemaIndexEntry"];
export type StreamEvent = Schemas["StreamEvent"];
export type StreamLimits = Schemas["StreamLimits"];
export type UserRole = Schemas["UserRole"];
export type WsTicket = Schemas["WsTicket"];
export type WsTicketCreate = Schemas["WsTicketCreate"];

export type StreamEventType = StreamEvent["type"];

export type PayloadOf<Type extends StreamEventType> = Extract<
  StreamEvent,
  { type: Type }
>["payload"];

export type PersistedEventType =
  "run.created" | "run.status_changed" | "hello.tick" | "hello.laya" | "run.finished";

export type EphemeralEventType = Exclude<StreamEventType, PersistedEventType>;

export interface MockUser extends AuthUser {
  password: string;
  isActive: boolean;
}

export type EventEnvelope = {
  type: string;
  run_id: string | null;
  seq: number | null;
  ts: string;
  payload: object;
};
