import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import {
  GOAL_SCHEMA_NAME,
  OPTIONS_PAGE_SIZE,
  PERSONA_SCHEMA_NAME,
  SCHEMA_VERSION,
  SESSION_PAGE_SIZE,
  SIMULATOR_PAGE_SIZE,
} from "./schemas";
import type { GoalKind, VerdictStatus } from "./types";

export const SIMULATOR_SCHEMA_STALE_TIME_MS = 60 * 60 * 1000;

export type SimulatorSchemaName = typeof PERSONA_SCHEMA_NAME | typeof GOAL_SCHEMA_NAME;

export interface PersonaFilters {
  targetId: string;
  q?: string;
}

export interface GoalFilters {
  targetId: string;
  q?: string;
  kind?: GoalKind[];
}

export interface SimSessionFilters {
  runId?: string;
  personaId?: string;
  goalId?: string;
  verdict?: VerdictStatus[];
}

export function simulatorSchemaQuery(name: SimulatorSchemaName) {
  return queryOptions({
    queryKey: qk.system.schema(name, SCHEMA_VERSION),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/schemas/{name}.v{version}.json", {
          params: { path: { name, version: SCHEMA_VERSION } },
          signal,
        }),
      ) as Promise<unknown>,
    staleTime: SIMULATOR_SCHEMA_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

export function personasQuery({ targetId, q }: PersonaFilters) {
  return cursorInfiniteOptions({
    queryKey: qk.personas.list(targetId, { q, limit: SIMULATOR_PAGE_SIZE }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/personas", {
          params: {
            query: {
              target_id: targetId,
              q,
              cursor,
              limit: SIMULATOR_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function personaOptionsQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.personas.list(targetId, { options: true, limit: OPTIONS_PAGE_SIZE }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/personas", {
          params: { query: { target_id: targetId, limit: OPTIONS_PAGE_SIZE } },
          signal,
        }),
      ),
    select: (page) => page.items,
  });
}

export function goalsQuery({ targetId, q, kind }: GoalFilters) {
  return cursorInfiniteOptions({
    queryKey: qk.goals.list(targetId, { q, kind, limit: SIMULATOR_PAGE_SIZE }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/goals", {
          params: {
            query: {
              target_id: targetId,
              q,
              kind,
              cursor,
              limit: SIMULATOR_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function goalOptionsQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.goals.list(targetId, { options: true, limit: OPTIONS_PAGE_SIZE }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/goals", {
          params: { query: { target_id: targetId, limit: OPTIONS_PAGE_SIZE } },
          signal,
        }),
      ),
    select: (page) => page.items,
  });
}

export function simSessionsQuery(filters: SimSessionFilters = {}) {
  const { runId, personaId, goalId, verdict } = filters;
  return cursorInfiniteOptions({
    queryKey: qk.simSessions.list(runId ?? "all", {
      personaId,
      goalId,
      verdict,
      limit: SESSION_PAGE_SIZE,
    }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/sim-sessions", {
          params: {
            query: {
              run_id: runId,
              persona_id: personaId,
              goal_id: goalId,
              verdict,
              cursor,
              limit: SESSION_PAGE_SIZE,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function simSessionQuery(simSessionId: string) {
  return queryOptions({
    queryKey: qk.simSessions.detail(simSessionId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/sim-sessions/{sim_session_id}", {
          params: { path: { sim_session_id: simSessionId } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
  });
}
