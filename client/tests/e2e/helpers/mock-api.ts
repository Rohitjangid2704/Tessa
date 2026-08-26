import type { APIRequestContext } from "@playwright/test";
import type { FaultPatch, FaultSnapshot } from "../../../mocks/server/faults";
import { apiOrigin } from "./env";

interface FaultsResponse {
  faults: FaultSnapshot;
}

export async function setMockFaults(
  request: APIRequestContext,
  patch: FaultPatch,
): Promise<FaultSnapshot> {
  const response = await request.post(`${apiOrigin()}/__mock/faults`, { data: patch });
  if (!response.ok()) {
    throw new Error(`mock faults request failed with ${response.status()}`);
  }
  return ((await response.json()) as FaultsResponse).faults;
}

export async function clearMockFaults(request: APIRequestContext): Promise<void> {
  await request.delete(`${apiOrigin()}/__mock/faults`);
}

export async function resetMockApi(request: APIRequestContext): Promise<void> {
  await request.post(`${apiOrigin()}/__mock/reset`);
}

export async function readMockState(request: APIRequestContext) {
  const response = await request.get(`${apiOrigin()}/__mock/state`);
  return (await response.json()) as {
    faults: FaultSnapshot;
    runs: Array<{ run_id: string; events: number; finished: boolean }>;
    connections: { opened: number; open: number; ticketsIssued: number };
  };
}
