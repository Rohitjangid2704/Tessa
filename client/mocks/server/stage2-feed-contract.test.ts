import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningMockServer } from "@/mocks/server/http";
import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";
import { EventStream } from "@/lib/sse/stream";
import { mockState } from "@/mocks/state";
import { bearer, mintApiToken } from "@/tests/utils/tokens";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage2Client,
  errorOf,
  FeedProbe,
  GRACIE_ID,
  isGapFree,
  STAGE_ONE_IDS,
  type Stage2Client,
} from "@/tests/utils/stage2";

let running: RunningMockServer;
let client: Stage2Client;
const probes: FeedProbe[] = [];

beforeAll(async () => {
  running = await startMockApi({ config: { heartbeatIntervalMs: 120 } });
  client = createStage2Client(running.baseUrl);
});

afterAll(async () => {
  mockState.reset();
  mockState.restoreConfig();
  await running.close();
});

beforeEach(async () => {
  mockState.reset();
  await client.control.clock({ speed: 1000 });
});

afterEach(() => {
  for (const probe of probes.splice(0)) {
    probe.close();
  }
});

async function open(query = ""): Promise<FeedProbe> {
  const probe = await client.openFeed(query);
  probes.push(probe);
  return probe;
}

describe("GET /feeds/runs", () => {
  it("answers with an event stream and sends stream.hello first", async () => {
    const feed = await open();
    expect(feed.status).toBe(200);
    expect(feed.contentType).toContain("text/event-stream");
    await feed.waitForType("stream.hello");
    expect(feed.messages[0]).toMatchObject({
      event: "stream.hello",
      envelope: {
        type: "stream.hello",
        run_id: null,
        seq: null,
        payload: { feed: "runs", heartbeat_seconds: 1, run_id: null, head_seq: null },
      },
    });
    const parsed = parseStreamMessage(feed.messages[0]?.envelope);
    expect(parsed.kind).toBe("known");
  });

  it("sends : ping comments as the heartbeat", async () => {
    const feed = await open();
    await feed.waitUntil(() => feed.comments >= 2);
    expect(feed.comments).toBeGreaterThanOrEqual(2);
  });

  it("delivers only the run list events, in the SSE envelope with the origin seq", async () => {
    const feed = await open();
    await feed.waitForType("stream.hello");
    const handle = await client.startInlineRun({ roles: ["guest"] });
    await client.runToEnd(handle.run_id);
    await feed.waitForType("run.finished");
    const types = new Set(feed.types);
    expect(types).toEqual(
      new Set([
        "stream.hello",
        "run.created",
        "run.status_changed",
        "run.progress",
        "budget.updated",
        "run.finished",
      ]),
    );
    const own = feed.messages.filter((message) => message.envelope.run_id === handle.run_id);
    const seqs = own.map((message) => message.envelope.seq as number);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(own[0]?.envelope).toMatchObject({
      type: "run.created",
      seq: 1,
      payload: { kind: "suite", target_id: GRACIE_ID, status: "queued" },
    });
    for (const message of own) {
      expect(message.event).toBe(message.envelope.type);
      expect(parseStreamMessage(message.envelope).kind).toBe("known");
    }
    expect(own.at(-1)?.envelope.payload).toMatchObject({ status: "completed" });
    expect(isGapFree(seqs.filter((seq) => seq <= 3))).toBe(true);
  });

  it("carries budget.exhausted for a run that exhausts its budget", async () => {
    const feed = await open();
    await client.control.faults({ budget_exhausted: true });
    const handle = await client.startInlineRun({
      roles: [],
      feature_ids: [],
      area_ids: ["Account & Access"],
      interface_mode: "api_only",
    });
    await client.runToEnd(handle.run_id);
    await feed.waitForType("budget.exhausted");
    const finished = feed.messages.find((message) => message.envelope.type === "run.finished");
    expect(finished?.envelope.payload).toMatchObject({ status: "budget_exceeded" });
  });

  it("filters by target_id, kind and run_id", async () => {
    const forGracie = await open(`target_id=${GRACIE_ID}`);
    const forBilling = await open(`target_id=${STAGE_ONE_IDS.billing}`);
    const forSeed = await open("kind=seed&kind=explore");
    const forSuite = await open("kind=suite");
    await client.control.hold("running");
    const first = await client.startInlineRun({ roles: ["guest"] });
    const second = await client.startInlineRun({ roles: ["manager"] });
    const forFirst = await open(`run_id=${first.run_id}`);
    await client.control.release();
    await client.runToEnd(first.run_id);
    await forGracie.waitUntil(
      () => forGracie.messages.filter((m) => m.envelope.type === "run.finished").length === 2,
    );
    await forSuite.waitUntil(
      () => forSuite.messages.filter((m) => m.envelope.type === "run.finished").length === 2,
    );
    await forFirst.waitForType("run.finished");
    expect(
      forFirst.messages
        .filter((m) => m.envelope.type !== "stream.hello")
        .every((message) => message.envelope.run_id === first.run_id),
    ).toBe(true);
    expect(forBilling.messages.map((message) => message.envelope.type)).toEqual(["stream.hello"]);
    expect(forSeed.messages.map((message) => message.envelope.type)).toEqual(["stream.hello"]);
    expect(
      new Set(forGracie.messages.map((message) => message.envelope.run_id).filter(Boolean)),
    ).toEqual(new Set([first.run_id, second.run_id]));
  });

  it("answers 401 without a bearer token, 422 for bad filters and 403 is not used", async () => {
    const anonymous = await client.openFeed("", { token: null });
    probes.push(anonymous);
    expect(anonymous.status).toBe(401);
    const response = await fetch(client.feedUrl("kind=party"), {
      headers: { Authorization: (await client.headers()).Authorization as string },
    });
    expect(response.status).toBe(422);
    expect((await errorOf(response)).details[0]?.loc).toEqual(["query", "kind", 0]);
    const unknown = await fetch(client.feedUrl("colour=red"), {
      headers: { Authorization: (await client.headers()).Authorization as string },
    });
    expect(unknown.status).toBe(422);
    const viewer = await fetch(client.feedUrl(), {
      headers: { Authorization: (await client.headers("viewer")).Authorization as string },
    });
    expect(viewer.status).toBe(200);
    await viewer.body?.cancel();
  });

  it("drops the connection after the hello when the feed_drop fault is set", async () => {
    await client.control.faults({ feed_drop: true });
    const dropped = await open();
    await dropped.waitUntil(() => dropped.ended);
    expect(dropped.types).toEqual(["stream.hello"]);
    const reconnected = await open();
    await reconnected.waitForType("stream.hello");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reconnected.ended).toBe(false);
  });

  it("drops every open connection from the control endpoint and counts them", async () => {
    const one = await open();
    const two = await open();
    await one.waitForType("stream.hello");
    await two.waitForType("stream.hello");
    const state = (await client.control.state()) as { feeds: { open: number } };
    expect(state.feeds.open).toBe(2);
    const dropped = await client.control.dropFeeds();
    expect((await dropped.json()).dropped).toBe(2);
    await one.waitUntil(() => one.ended);
    await two.waitUntil(() => two.ended);
    const after = (await client.control.state()) as { feeds: { open: number } };
    expect(after.feeds.open).toBe(0);
  });

  it("ends the stream with stream.closing at the maximum age", async () => {
    mockState.configure({ streamMaxAgeMs: 150 });
    const feed = await open();
    await feed.waitForType("stream.closing");
    expect(feed.messages.at(-1)?.envelope.payload).toEqual({ reason: "max_age" });
    await feed.waitUntil(() => feed.ended);
    mockState.restoreConfig();
    mockState.configure({ heartbeatIntervalMs: 120 });
  });

  it("is read by the app's EventStream: live after the hello, events delivered, reconnect after a drop", async () => {
    const token = await mintApiToken();
    const stream = new EventStream({
      url: client.feedUrl("kind=suite"),
      fetch: (request) =>
        fetch(request.url, {
          headers: { Accept: "text/event-stream", ...bearer(token) },
          signal: request.signal,
        }),
      random: () => 0.5,
    });
    const events: KnownStreamEvent[] = [];
    let hellos = 0;
    stream.setListeners({
      onEvent: (event) => events.push(event),
      onHello: () => {
        hellos += 1;
      },
    });
    stream.connect();
    try {
      await vi.waitFor(() => expect(stream.getState().status).toBe("live"));
      const handle = await client.startInlineRun({ roles: ["guest"] });
      await client.runToEnd(handle.run_id);
      await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("run.finished"));
      expect(stream.getState()).toMatchObject({ invalidMessageCount: 0, unknownEventCount: 0 });

      await client.control.dropFeeds();
      await vi.waitFor(() => expect(stream.getState().status).toBe("reconnecting"));
      await vi.waitFor(() => expect(hellos).toBe(2), { timeout: 4000 });
      expect(stream.getState().status).toBe("live");
    } finally {
      stream.close();
    }
  });

  it("does not leak run socket frames into the feed", async () => {
    const feed = await open();
    await feed.waitForType("stream.hello");
    const handle = await client.startInlineRun({
      feature_ids: ["guest_requests.flow.request_and_track"],
      roles: ["guest"],
      interface_mode: "browser_only",
    });
    await client.runToEnd(handle.run_id);
    await feed.waitForType("run.finished");
    expect(feed.types.some((type) => type.startsWith("tile.") || type.startsWith("step."))).toBe(
      false,
    );
    expect(
      feed.types.some((type) => type.startsWith("scenario.") || type.startsWith("browser")),
    ).toBe(false);
  });
});
