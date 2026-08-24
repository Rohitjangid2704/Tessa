import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { RUN_ID, serveRun, tickEvents } from "@/tests/utils/run-detail-fixtures";
import { envelope } from "@/tests/utils/stream-fixtures";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { fetchRunEventsPage, RUN_EVENTS_TAIL_LIMIT } = await import("./run-event-pages");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("fetchRunEventsPage", () => {
  it("asks for the newest events first and returns them oldest first", async () => {
    const { requests } = serveRun({ events: tickEvents(5) });

    const page = await fetchRunEventsPage(RUN_ID);

    const [request] = requests.events;
    expect(request?.searchParams.get("order")).toBe("desc");
    expect(request?.searchParams.get("limit")).toBe(String(RUN_EVENTS_TAIL_LIMIT));
    expect(request?.searchParams.get("before_seq")).toBeNull();
    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(page).toMatchObject({
      lowestSeq: 1,
      highestSeq: 5,
      headSeq: 5,
      hasMore: false,
      skipped: 0,
    });
  });

  it("keeps the 200 newest of a longer run and reports that older ones exist", async () => {
    serveRun({ events: tickEvents(250) });

    const page = await fetchRunEventsPage(RUN_ID);

    expect(page.events).toHaveLength(200);
    expect(page.events[0]?.seq).toBe(51);
    expect(page.events.at(-1)?.seq).toBe(250);
    expect(page).toMatchObject({ lowestSeq: 51, highestSeq: 250, headSeq: 250, hasMore: true });
  });

  it("pages backwards with before_seq", async () => {
    const { requests } = serveRun({ events: tickEvents(250) });

    const older = await fetchRunEventsPage(RUN_ID, { beforeSeq: 51, limit: 100 });

    expect(requests.events[0]?.searchParams.get("before_seq")).toBe("51");
    expect(older.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(older.hasMore).toBe(false);
    expect(older.highestSeq).toBe(50);
  });

  it("counts unknown and invalid events but still advances the seq range", async () => {
    serveRun({
      events: [
        ...tickEvents(2),
        envelope("future.thing", 3, { anything: true }),
        envelope("hello.tick", 4, { n: "not a number" }),
        ...tickEvents(1, 5),
      ],
    });

    const page = await fetchRunEventsPage(RUN_ID);

    expect(page.events.map((event) => event.seq)).toEqual([1, 2, 5]);
    expect(page).toMatchObject({ skipped: 2, lowestSeq: 1, highestSeq: 5 });
  });

  it("returns an empty page for a run without events", async () => {
    serveRun({ events: [] });

    const page = await fetchRunEventsPage(RUN_ID);

    expect(page).toEqual({
      events: [],
      lowestSeq: null,
      highestSeq: 0,
      headSeq: 0,
      hasMore: false,
      skipped: 0,
    });
  });

  it("throws the API error for a failed request", async () => {
    serveRun({ eventsFailure: { status: 500 } });

    await expect(fetchRunEventsPage(RUN_ID)).rejects.toBeInstanceOf(ApiError);
  });
});
