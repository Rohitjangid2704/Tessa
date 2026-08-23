import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/api/query-keys";
import type { Label, LabelStats } from "@/lib/api/types";
import { MEMBER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { stageFourId } from "@/mocks/stage4/label-seed";
import { signInAs } from "@/tests/utils/api-session";
import { createTestQueryClient } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { adjustStats, postLabel, useCreateLabel, useDeleteLabel } from "./mutations";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const STEP_ID = stageFourId("step", 700);
const RUN_ID = stageFourId("run", 7);
const PROBE_ID = stageFourId("subject", 700);

const STATS: LabelStats = {
  total_human: 4,
  total_weak: 2,
  by_subject_type: { step: 3, probe_result: 1 },
  agreement_with_machine: 0.5,
};

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

interface CallRecorder {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}

function invalidatedKeys(spy: CallRecorder): string[] {
  return spy.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
}

function failLabelPost(status = 500, delayMs = 0): void {
  server.use(
    http.post("*/api/v1/labels", async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return HttpResponse.json(
        { error: { code: "internal_error", message: "Down", request_id: "req-m", details: [] } },
        { status },
      );
    }),
  );
}

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("adjustStats", () => {
  it("moves the total and the count of one subject type and keeps the rest", () => {
    expect(adjustStats(STATS, "step", 1)).toEqual({
      ...STATS,
      total_human: 5,
      by_subject_type: { step: 4, probe_result: 1 },
    });
    expect(adjustStats(STATS, "judge_result", 1).by_subject_type).toEqual({
      step: 3,
      probe_result: 1,
      judge_result: 1,
    });
  });

  it("never goes below zero", () => {
    const empty: LabelStats = { ...STATS, total_human: 0, by_subject_type: {} };

    expect(adjustStats(empty, "step", -1)).toMatchObject({
      total_human: 0,
      by_subject_type: { step: 0 },
    });
  });
});

describe("postLabel", () => {
  it("reports 201 as new and 200 as a replacement", async () => {
    const label = { subject_type: "step" as const, subject_id: STEP_ID, value: "pass" as const };

    const created = await postLabel({ label, idempotencyKey: "key-one-12345" });
    const replaced = await postLabel({
      label: { ...label, value: "fail" },
      idempotencyKey: "key-two-12345",
    });

    expect(created.replaced).toBe(false);
    expect(replaced.replaced).toBe(true);
    expect(replaced.label.id).toBe(created.label.id);
    expect(replaced.label.value).toBe("fail");
  });

  it("throws an ApiError with the request id on a failure", async () => {
    failLabelPost(422);

    await expect(
      postLabel({
        label: { subject_type: "step", subject_id: STEP_ID, value: "pass" },
        idempotencyKey: "key-three-12345",
      }),
    ).rejects.toMatchObject({ status: 422, code: "internal_error", requestId: "req-m" });
  });
});

describe("useCreateLabel", () => {
  it("stores the label as the own label and invalidates the run counters for a step label", async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateLabel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        label: { subject_type: "step", subject_id: STEP_ID, value: "fail" },
        idempotencyKey: "key-four-12345",
        runId: RUN_ID,
      });
    });

    expect(queryClient.getQueryData(qk.labels.own("step", STEP_ID))).toMatchObject({
      value: "fail",
      source: "human",
    });
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(qk.labels.stats()));
    expect(keys).toContain(JSON.stringify(qk.labels.lists()));
    expect(keys).toContain(JSON.stringify(qk.runs.forRun(RUN_ID)));
    expect(keys).toContain(JSON.stringify(qk.runs.lists()));
    expect(keys).toContain(JSON.stringify(qk.runScenarios.all()));
    expect(keys).toContain(JSON.stringify(qk.steps.detail(STEP_ID)));
  });

  it("invalidates every run query when a step label has no run id", async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateLabel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        label: { subject_type: "step", subject_id: STEP_ID, value: "pass" },
        idempotencyKey: "key-five-12345",
      });
    });

    expect(invalidatedKeys(invalidate)).toContain(JSON.stringify(qk.runs.all()));
  });

  it("leaves the run counters alone for a label that is not on a step", async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateLabel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        label: { subject_type: "probe_result", subject_id: PROBE_ID, value: "pass" },
        idempotencyKey: "key-six-123456",
        runId: RUN_ID,
      });
    });

    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(qk.labels.stats()));
    expect(keys).not.toContain(JSON.stringify(qk.runScenarios.all()));
    expect(keys).not.toContain(JSON.stringify(qk.runs.forRun(RUN_ID)));
    expect(keys).not.toContain(JSON.stringify(qk.runs.lists()));
  });

  it("bumps the cached stats at once and takes the bump back when the request fails", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(qk.labels.stats(), STATS);
    failLabelPost(500, 400);
    const { result } = renderHook(() => useCreateLabel(), { wrapper });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current
        .mutateAsync({
          label: { subject_type: "step", subject_id: STEP_ID, value: "pass" },
          idempotencyKey: "key-seven-12345",
          optimisticStats: true,
        })
        .catch(() => undefined);
    });

    await waitFor(() =>
      expect(queryClient.getQueryData<LabelStats>(qk.labels.stats())?.total_human).toBe(5),
    );
    await act(async () => {
      await pending;
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData<LabelStats>(qk.labels.stats())?.total_human).toBe(4);
  });

  it("does not touch the cached stats without optimisticStats", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(qk.labels.stats(), STATS);
    failLabelPost();
    const { result } = renderHook(() => useCreateLabel(), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({
          label: { subject_type: "step", subject_id: STEP_ID, value: "pass" },
          idempotencyKey: "key-eight-12345",
        })
        .catch(() => undefined);
    });

    expect(queryClient.getQueryData<LabelStats>(qk.labels.stats())?.total_human).toBe(4);
  });
});

describe("useDeleteLabel", () => {
  function saveLabel(subjectType: Label["subject_type"], subjectId: string): Label {
    return mockState.stageFour.labels.saveHuman(
      MEMBER_USER.id,
      { subject_type: subjectType, subject_id: subjectId, value: "pass", note: null },
      "2026-10-03T08:00:00.000Z",
    ).label;
  }

  it("deletes the label, clears the own label and invalidates the run counters for a step", async () => {
    const label = saveLabel("step", STEP_ID);
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(qk.labels.own("step", STEP_ID), label);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteLabel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ label, runId: RUN_ID });
    });

    expect(queryClient.getQueryData(qk.labels.own("step", STEP_ID))).toBeNull();
    expect(mockState.stageFour.labels.humanRecords()).toHaveLength(0);
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(qk.runs.forRun(RUN_ID)));
    expect(keys).toContain(JSON.stringify(qk.runScenarios.all()));
    expect(keys).toContain(JSON.stringify(qk.steps.detail(STEP_ID)));
    expect(keys).toContain(JSON.stringify(qk.labels.stats()));
  });

  it("restores the own label and the stats when the delete fails", async () => {
    const label = saveLabel("judge_result", PROBE_ID);
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(qk.labels.own("judge_result", PROBE_ID), label);
    queryClient.setQueryData(qk.labels.stats(), STATS);
    server.use(
      http.delete("*/api/v1/labels/:id", () =>
        HttpResponse.json(
          { error: { code: "forbidden", message: "No", request_id: "req-d", details: [] } },
          { status: 403 },
        ),
      ),
    );
    const { result } = renderHook(() => useDeleteLabel(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ label, optimisticStats: true }).catch(() => undefined);
    });

    expect(queryClient.getQueryData(qk.labels.own("judge_result", PROBE_ID))).toEqual(label);
    expect(queryClient.getQueryData<LabelStats>(qk.labels.stats())?.total_human).toBe(4);
  });
});
