import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  Label,
  LabelPage,
  LabelStats,
  LabelTask,
  LabelTaskPage,
  ProbePage,
} from "@/lib/api/types";
import { ADMIN_USER, MEMBER_USER } from "@/mocks/factories/users";
import type { RunningMockServer } from "@/mocks/server/http";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { LABEL_TASK_COUNT, stageFourId } from "@/mocks/stage4/label-seed";
import { PROBE_BANK_VERSION } from "@/mocks/fixtures/probe-bank";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import { createStage1Client, errorOf, type Role, type Stage1Client } from "@/tests/utils/stage1";

let running: RunningMockServer;
let client: Stage1Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage1Client(running.baseUrl);
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

async function readQueue(query = "", role?: Role): Promise<LabelTaskPage> {
  const response = await client.get(`/api/v1/labels/queue${query}`, role);
  expect(response.status).toBe(200);
  return (await response.json()) as LabelTaskPage;
}

async function readStats(): Promise<LabelStats> {
  const response = await client.get("/api/v1/labels/stats");
  expect(response.status).toBe(200);
  return (await response.json()) as LabelStats;
}

async function firstTask(query = ""): Promise<LabelTask> {
  const page = await readQueue(`?limit=1${query}`);
  const task = page.items[0];
  if (task === undefined) {
    throw new Error("the queue is empty");
  }
  return task;
}

function labelBody(task: LabelTask, value: Label["value"], extra: Record<string, unknown> = {}) {
  return { subject_type: task.subject_type, subject_id: task.subject_id, value, ...extra };
}

async function postLabel(
  body: unknown,
  options: { role?: Role; key?: string | null } = {},
): Promise<Response> {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return client.send("POST", "/api/v1/labels", body, {
    role: options.role,
    headers: key === null ? {} : { "Idempotency-Key": key },
  });
}

describe("GET /probes", () => {
  it("requires a token and answers the viewer role", async () => {
    const anonymous = await fetch(`${running.baseUrl}/api/v1/probes`);
    expect(anonymous.status).toBe(401);
    const response = await client.get("/api/v1/probes", "viewer");
    expect(response.status).toBe(200);
  });

  it("lists the bank with pack, question, answer type, threshold, version and source", async () => {
    const page = (await (
      await client.get("/api/v1/probes?include_total=true")
    ).json()) as ProbePage;
    expect(page.total).toBe(12);
    expect(page.items.map((probe) => probe.id)).toEqual(
      [...page.items.map((probe) => probe.id)].sort((left, right) => left.localeCompare(right)),
    );
    for (const probe of page.items) {
      expect(probe.version).toBe(PROBE_BANK_VERSION);
      expect(probe.threshold).toBeGreaterThan(0);
      expect(probe.threshold).toBeLessThanOrEqual(1);
      expect(probe.question.length).toBeGreaterThan(0);
      expect(["generic", "llm_app", "target"]).toContain(probe.pack);
      expect(["generic", "llm_app", "target"]).toContain(probe.source);
    }
    expect(new Set(page.items.map((probe) => probe.pack))).toEqual(
      new Set(["generic", "llm_app", "target"]),
    );
    expect(page.items.find((probe) => probe.id === "generic.language_matches_user")).toMatchObject({
      pack: "generic",
      source: "target",
    });
  });

  it("filters by repeated pack and by text", async () => {
    const llm = (await (await client.get("/api/v1/probes?pack=llm_app")).json()) as ProbePage;
    expect(llm.items.length).toBeGreaterThan(0);
    expect(llm.items.every((probe) => probe.pack === "llm_app")).toBe(true);

    const two = (await (
      await client.get("/api/v1/probes?pack=generic&pack=target")
    ).json()) as ProbePage;
    expect(new Set(two.items.map((probe) => probe.pack))).toEqual(new Set(["generic", "target"]));

    const text = (await (await client.get("/api/v1/probes?q=SYSTEM")).json()) as ProbePage;
    expect(text.items.map((probe) => probe.id)).toEqual(["llm_app.leaks_system_prompt"]);
  });

  it("pages with an opaque cursor", async () => {
    const first = (await (await client.get("/api/v1/probes?limit=5")).json()) as ProbePage;
    expect(first.items).toHaveLength(5);
    expect(typeof first.next_cursor).toBe("string");
    const second = (await (
      await client.get(`/api/v1/probes?limit=100&cursor=${first.next_cursor}`)
    ).json()) as ProbePage;
    expect(first.items.length + second.items.length).toBe(12);
    expect(second.next_cursor).toBeNull();
  });

  it("rejects an unknown pack and unknown query keys with 422", async () => {
    const pack = await client.get("/api/v1/probes?pack=nope");
    expect(pack.status).toBe(422);
    expect((await errorOf(pack)).details[0]?.loc).toEqual(["query", "pack", 0]);
    const unknown = await client.get("/api/v1/probes?bogus=1");
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).details[0]?.loc).toEqual(["query", "bogus"]);
  });
});

describe("GET /labels/queue", () => {
  it("requires a token and answers the viewer role", async () => {
    const anonymous = await fetch(`${running.baseUrl}/api/v1/labels/queue`);
    expect(anonymous.status).toBe(401);
    await readQueue("", "viewer");
  });

  it("holds 60 tasks with all four reasons and all four subject types", async () => {
    const page = await readQueue("?limit=200&include_total=true");
    expect(page.total).toBe(LABEL_TASK_COUNT);
    expect(page.items).toHaveLength(LABEL_TASK_COUNT);
    expect(page.next_cursor).toBeNull();
    expect(new Set(page.items.map((task) => task.reason))).toEqual(
      new Set(["uncertain", "judge_flagged", "disagreement", "audit"]),
    );
    expect(new Set(page.items.map((task) => task.subject_type))).toEqual(
      new Set(["probe_result", "judge_result", "invariant_result", "step"]),
    );
    expect(new Set(page.items.map((task) => task.id)).size).toBe(LABEL_TASK_COUNT);
  });

  it("gives every task a question, an excerpt, ids, a machine value and a creation time", async () => {
    const page = await readQueue("?limit=200");
    for (const task of page.items) {
      expect(task.question.length).toBeGreaterThan(0);
      expect(task.evidence_excerpt.length).toBeGreaterThan(0);
      expect(task.run_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(task.step_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(task.created_at)).not.toBeNaN();
      if (task.machine_value === null) {
        expect(task.machine_confidence).toBeNull();
      } else {
        expect(task.machine_confidence).toBeGreaterThan(0);
        expect(task.machine_confidence).toBeLessThanOrEqual(1);
      }
      if (task.subject_type === "step") {
        expect(task.subject_id).toBe(task.step_id);
      }
    }
    expect(page.items.some((task) => task.machine_value === null)).toBe(true);
    expect(page.items.some((task) => task.evidence_excerpt.length > 400)).toBe(true);
    expect(page.items.some((task) => task.evidence_excerpt.includes("<script>"))).toBe(true);
  });

  it("is ordered oldest first and pages with an opaque cursor", async () => {
    const first = await readQueue("?limit=25&include_total=true");
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(LABEL_TASK_COUNT);
    expect(typeof first.next_cursor).toBe("string");
    const second = await readQueue(`?limit=25&cursor=${first.next_cursor}`);
    const third = await readQueue(`?limit=25&cursor=${second.next_cursor}`);
    expect(third.items).toHaveLength(10);
    expect(third.next_cursor).toBeNull();
    const all = [...first.items, ...second.items, ...third.items];
    const times = all.map((task) => Date.parse(task.created_at));
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(all.map((task) => task.id)).size).toBe(LABEL_TASK_COUNT);
  });

  it("filters by repeated subject_type, repeated reason and target_id", async () => {
    const steps = await readQueue("?limit=200&subject_type=step");
    expect(steps.items.length).toBeGreaterThan(0);
    expect(steps.items.every((task) => task.subject_type === "step")).toBe(true);

    const two = await readQueue("?limit=200&subject_type=step&subject_type=probe_result");
    expect(new Set(two.items.map((task) => task.subject_type))).toEqual(
      new Set(["step", "probe_result"]),
    );

    const audits = await readQueue(
      "?limit=200&reason=audit&reason=disagreement&include_total=true",
    );
    expect(new Set(audits.items.map((task) => task.reason))).toEqual(
      new Set(["audit", "disagreement"]),
    );
    expect(audits.total).toBe(audits.items.length);

    const gracie = await readQueue(`?limit=200&target_id=${STAGE_ONE_IDS.gracie}`);
    const billing = await readQueue(`?limit=200&target_id=${STAGE_ONE_IDS.billing}`);
    expect(gracie.items.length + billing.items.length).toBe(LABEL_TASK_COUNT);
    expect(billing.items.length).toBe(24);
    expect(gracie.items.length).toBe(36);

    const billingAudits = await readQueue(
      `?limit=200&target_id=${STAGE_ONE_IDS.billing}&reason=audit&subject_type=step`,
    );
    expect(billingAudits.items).toHaveLength(2);

    const none = await readQueue(`?target_id=${STAGE_ONE_IDS.liveShop}&include_total=true`);
    expect(none.items).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("rejects bad filters, bad cursors and unknown query keys with 422", async () => {
    const reason = await client.get("/api/v1/labels/queue?reason=nope");
    expect(reason.status).toBe(422);
    expect((await errorOf(reason)).details[0]?.loc).toEqual(["query", "reason", 0]);
    const target = await client.get("/api/v1/labels/queue?target_id=not-a-uuid");
    expect(target.status).toBe(422);
    expect((await errorOf(target)).details[0]?.loc).toEqual(["query", "target_id"]);
    const cursor = await client.get("/api/v1/labels/queue?cursor=garbage");
    expect(cursor.status).toBe(422);
    const unknown = await client.get("/api/v1/labels/queue?bogus=1");
    expect(unknown.status).toBe(422);
  });

  it("drops a task once the caller labeled its subject and brings it back on delete", async () => {
    const task = await firstTask();
    const created = (await (await postLabel(labelBody(task, "pass"))).json()) as Label;
    const after = await readQueue("?limit=200&include_total=true");
    expect(after.total).toBe(LABEL_TASK_COUNT - 1);
    expect(after.items.map((entry) => entry.id)).not.toContain(task.id);

    const asMember = await readQueue("?limit=200&include_total=true", "member");
    expect(asMember.total).toBe(LABEL_TASK_COUNT);

    const removed = await client.send("DELETE", `/api/v1/labels/${created.id}`);
    expect(removed.status).toBe(204);
    const restored = await readQueue("?limit=1");
    expect(restored.items[0]?.id).toBe(task.id);
  });
});

describe("POST /labels", () => {
  it("creates a human label with 201 and echoes the label", async () => {
    const task = await firstTask();
    const response = await postLabel(labelBody(task, "fail", { note: "wrong room" }));
    expect(response.status).toBe(201);
    const label = (await response.json()) as Label;
    expect(label).toMatchObject({
      subject_type: task.subject_type,
      subject_id: task.subject_id,
      value: "fail",
      source: "human",
      note: "wrong room",
      labeled_by: ADMIN_USER.id,
    });
    expect(Date.parse(label.labeled_at)).not.toBeNaN();
    expect(label.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces the caller's earlier label of the same subject with 200 and the same id", async () => {
    const task = await firstTask();
    const first = (await (await postLabel(labelBody(task, "pass"))).json()) as Label;
    const response = await postLabel(labelBody(task, "fail", { note: "changed my mind" }));
    expect(response.status).toBe(200);
    const second = (await response.json()) as Label;
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ value: "fail", note: "changed my mind" });
    expect((await readStats()).total_human).toBe(1);
  });

  it("keeps labels of different users and different subject types apart", async () => {
    const task = await firstTask();
    expect((await postLabel(labelBody(task, "pass"))).status).toBe(201);
    expect((await postLabel(labelBody(task, "fail"), { role: "member" })).status).toBe(201);
    expect(task.subject_type).toBe("probe_result");
    const otherType = { ...labelBody(task, "pass"), subject_type: "step" } as const;
    expect((await postLabel(otherType)).status).toBe(201);
    expect((await readStats()).total_human).toBe(3);
  });

  it("answers 200 instead of 201 while the label_replaced_200 fault is set", async () => {
    mockState.faults.apply({ label_replaced_200: true });
    const task = await firstTask();
    const response = await postLabel(labelBody(task, "pass"));
    expect(response.status).toBe(200);
    expect((await readStats()).total_human).toBe(1);
    mockState.faults.apply({ label_replaced_200: null });
    const next = await readQueue("?limit=1");
    const second = await postLabel(labelBody(next.items[0] as LabelTask, "pass"));
    expect(second.status).toBe(201);
  });

  it("replays a repeated Idempotency-Key and rejects a different body on the same key", async () => {
    const task = await firstTask();
    const key = crypto.randomUUID();
    const first = await postLabel(labelBody(task, "pass"), { key });
    expect(first.status).toBe(201);
    const replay = await postLabel(labelBody(task, "pass"), { key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await readStats()).total_human).toBe(1);
    const conflict = await postLabel(labelBody(task, "fail"), { key });
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe("idempotency_conflict");
  });

  it("treats the Idempotency-Key as optional but rejects a malformed one", async () => {
    const task = await firstTask();
    expect((await postLabel(labelBody(task, "pass"), { key: null })).status).toBe(201);
    const next = (await readQueue("?limit=1")).items[0] as LabelTask;
    const bad = await postLabel(labelBody(next, "pass"), { key: "short" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("idempotency_key_required");
  });

  it("validates the body with the field as the location", async () => {
    const empty = await postLabel({});
    expect(empty.status).toBe(422);
    expect((await errorOf(empty)).details.map((detail) => detail.loc)).toEqual([
      ["body", "subject_type"],
      ["body", "subject_id"],
      ["body", "value"],
    ]);

    const bad = await postLabel({
      subject_type: "nope",
      subject_id: "not-a-uuid",
      value: "maybe",
      note: "x".repeat(2001),
    });
    expect(bad.status).toBe(422);
    const details = (await errorOf(bad)).details;
    expect(details.map((detail) => detail.loc)).toEqual([
      ["body", "subject_type"],
      ["body", "subject_id"],
      ["body", "value"],
      ["body", "note"],
    ]);
    expect(details[0]?.message).toContain("probe_result");
  });

  it("accepts a subject that is not in the queue", async () => {
    const response = await postLabel({
      subject_type: "step",
      subject_id: stageFourId("step", 999),
      value: "uncertain",
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Label).note).toBeNull();
  });

  it("needs the member role and a token", async () => {
    const task = await firstTask();
    const viewer = await postLabel(labelBody(task, "pass"), { role: "viewer" });
    expect(viewer.status).toBe(403);
    expect((await errorOf(viewer)).code).toBe("role_required");
    const anonymous = await fetch(`${running.baseUrl}/api/v1/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labelBody(task, "pass")),
    });
    expect(anonymous.status).toBe(401);
  });
});

describe("GET /labels", () => {
  it("looks up the caller's own label of a subject", async () => {
    const task = await firstTask();
    expect(
      (
        (await (
          await client.get(
            `/api/v1/labels?subject_type=${task.subject_type}&subject_id=${task.subject_id}&source=human&labeled_by=${ADMIN_USER.id}`,
          )
        ).json()) as LabelPage
      ).items,
    ).toEqual([]);

    const created = (await (await postLabel(labelBody(task, "pass"))).json()) as Label;
    await postLabel(labelBody(task, "fail"), { role: "member" });

    const own = (await (
      await client.get(
        `/api/v1/labels?subject_type=${task.subject_type}&subject_id=${task.subject_id}&source=human&labeled_by=${ADMIN_USER.id}`,
      )
    ).json()) as LabelPage;
    expect(own.items).toEqual([created]);

    const everyone = (await (
      await client.get(`/api/v1/labels?subject_id=${task.subject_id}&include_total=true`)
    ).json()) as LabelPage;
    expect(everyone.total).toBe(2);
    expect(everyone.items.map((label) => label.labeled_by).sort()).toEqual(
      [ADMIN_USER.id, MEMBER_USER.id].sort(),
    );
  });

  it("filters by source and lists newest first", async () => {
    const weak = (await (
      await client.get("/api/v1/labels?source=judge_weak&limit=200")
    ).json()) as LabelPage;
    expect(weak.items).toHaveLength(7);
    expect(weak.items.every((label) => label.labeled_by === null)).toBe(true);
    const times = weak.items.map((label) => Date.parse(label.labeled_at));
    expect(times).toEqual([...times].sort((left, right) => right - left));
    const human = (await (await client.get("/api/v1/labels?source=human")).json()) as LabelPage;
    expect(human.items).toEqual([]);
  });

  it("rejects a bad subject_id and unknown query keys with 422", async () => {
    const bad = await client.get("/api/v1/labels?subject_id=nope");
    expect(bad.status).toBe(422);
    expect((await errorOf(bad)).details[0]?.loc).toEqual(["query", "subject_id"]);
    expect((await client.get("/api/v1/labels?bogus=1")).status).toBe(422);
  });
});

describe("DELETE /labels/{label_id}", () => {
  it("deletes the caller's own human label with 204", async () => {
    const task = await firstTask();
    const created = (await (await postLabel(labelBody(task, "pass"))).json()) as Label;
    const response = await client.send("DELETE", `/api/v1/labels/${created.id}`);
    expect(response.status).toBe(204);
    expect((await readStats()).total_human).toBe(0);
    expect((await client.send("DELETE", `/api/v1/labels/${created.id}`)).status).toBe(404);
  });

  it("answers 403 forbidden for another user's label and for a judge_weak label", async () => {
    const task = await firstTask();
    const memberLabel = (await (
      await postLabel(labelBody(task, "pass"), { role: "member" })
    ).json()) as Label;
    const others = await client.send("DELETE", `/api/v1/labels/${memberLabel.id}`);
    expect(others.status).toBe(403);
    expect((await errorOf(others)).code).toBe("forbidden");

    const weak = (await (await client.get("/api/v1/labels?source=judge_weak")).json()) as LabelPage;
    const weakId = weak.items[0]?.id ?? "";
    const weakResponse = await client.send("DELETE", `/api/v1/labels/${weakId}`);
    expect(weakResponse.status).toBe(403);
    expect((await readStats()).total_weak).toBe(7);
  });

  it("answers 404 for an unknown id, 422 for a malformed id and 403 for a viewer", async () => {
    expect(
      (await client.send("DELETE", `/api/v1/labels/${stageFourId("label", 4000)}`)).status,
    ).toBe(404);
    expect((await client.send("DELETE", "/api/v1/labels/not-a-uuid")).status).toBe(422);
    const viewer = await client.send(
      "DELETE",
      `/api/v1/labels/${stageFourId("label", 4000)}`,
      undefined,
      {
        role: "viewer",
      },
    );
    expect(viewer.status).toBe(403);
  });
});

describe("GET /labels/stats", () => {
  it("starts with no human labels, seven weak labels and no agreement", async () => {
    const stats = await readStats();
    expect(stats).toEqual({
      total_human: 0,
      total_weak: 7,
      by_subject_type: { probe_result: 0, judge_result: 0, step: 0, invariant_result: 0 },
      agreement_with_machine: null,
    });
    const viewer = await client.get("/api/v1/labels/stats", "viewer");
    expect(viewer.status).toBe(200);
  });

  it("moves when labels are created, replaced and deleted", async () => {
    const page = await readQueue("?limit=200&reason=uncertain");
    const [first, second] = page.items.filter((task) => task.machine_value !== null);
    if (first === undefined || second === undefined) {
      throw new Error("not enough tasks with a machine value");
    }
    const agreeing = (await (
      await postLabel(labelBody(first, first.machine_value ?? "pass"))
    ).json()) as Label;
    expect(await readStats()).toMatchObject({ total_human: 1, agreement_with_machine: 1 });

    const disagreeing = (await (
      await postLabel(labelBody(second, second.machine_value === "pass" ? "fail" : "pass"))
    ).json()) as Label;
    const two = await readStats();
    expect(two.total_human).toBe(2);
    expect(two.agreement_with_machine).toBe(0.5);
    expect(two.by_subject_type[first.subject_type]).toBeGreaterThan(0);

    await postLabel(labelBody(second, second.machine_value ?? "pass"));
    expect((await readStats()).agreement_with_machine).toBe(1);

    await client.send("DELETE", `/api/v1/labels/${agreeing.id}`);
    await client.send("DELETE", `/api/v1/labels/${disagreeing.id}`);
    expect(await readStats()).toMatchObject({ total_human: 0, agreement_with_machine: null });
  });

  it("ignores labels whose subject has no machine value in the agreement", async () => {
    await postLabel({ subject_type: "step", subject_id: stageFourId("step", 900), value: "pass" });
    expect(await readStats()).toMatchObject({ total_human: 1, agreement_with_machine: null });
  });
});

describe("POST /__mock/stage4/seed", () => {
  it("reseeds to an empty queue, to the default and to a nearly finished review", async () => {
    const control = (seed: unknown) =>
      fetch(`${running.baseUrl}/__mock/stage4/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed }),
      });

    const empty = await control("empty");
    expect(await empty.json()).toEqual({ seed: "empty", tasks: 0, human: 0, weak: 0 });
    expect((await readQueue("?include_total=true")).total).toBe(0);

    const nearly = await control("almost_done");
    expect(await nearly.json()).toEqual({ seed: "almost_done", tasks: 60, human: 48, weak: 7 });
    expect(await readStats()).toMatchObject({ total_human: 48, agreement_with_machine: 0.75 });
    expect((await readQueue("?include_total=true")).total).toBe(60);

    const fresh = await control("default");
    expect(await fresh.json()).toEqual({ seed: "default", tasks: 60, human: 0, weak: 7 });
  });

  it("rejects an unknown seed with 422 and is restored by /__mock/reset", async () => {
    const bad = await fetch(`${running.baseUrl}/__mock/stage4/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: "gracie" }),
    });
    expect(bad.status).toBe(422);

    mockState.stageFour.reset("empty");
    await fetch(`${running.baseUrl}/__mock/reset`, { method: "POST" });
    expect((await readQueue("?include_total=true")).total).toBe(LABEL_TASK_COUNT);
  });

  it("toggles label_replaced_200 through the faults control endpoint", async () => {
    const response = await fetch(`${running.baseUrl}/__mock/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_replaced_200: true }),
    });
    expect((await response.json()).faults).toMatchObject({ label_replaced_200: true });
    const cleared = await fetch(`${running.baseUrl}/__mock/faults`, { method: "DELETE" });
    expect((await cleared.json()).faults).toMatchObject({ label_replaced_200: false });
  });
});
