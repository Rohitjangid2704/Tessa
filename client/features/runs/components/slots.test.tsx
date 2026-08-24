import { beforeEach, describe, expect, it, vi } from "vitest";
import { StepInspector } from "@/features/steps/components/step-inspector";
import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { makeBrowserSession, makeRun, RUN_ID, serveRun } from "@/tests/utils/run-detail-fixtures";
import { renderWithStream } from "@/tests/utils/run-stream-harness";
import { screen, waitFor } from "@/tests/utils/render";
import { knownEnvelope, tickEnvelope } from "@/tests/utils/stream-fixtures";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { EventLog } = await import("./event-log");
const { ScenarioList } = await import("./scenario-list");
const { TileGrid } = await import("./tile-grid");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function known(wire: ReturnType<typeof knownEnvelope>): KnownStreamEvent {
  const parsed = parseStreamMessage(wire);
  if (parsed.kind !== "known") {
    throw new Error("fixture is not a known event");
  }
  return parsed.event;
}

describe("EventLog slot", () => {
  it("names its region and reports what the store holds", () => {
    renderWithStream(<EventLog runId={RUN_ID} />, {
      events: [known(tickEnvelope(1)), known(tickEnvelope(2))],
    });

    const region = screen.getByRole("region", { name: "Event log" });
    expect(region).toHaveTextContent("2 events loaded, last seq 2");
    expect(region).toHaveTextContent("Latest: Tick 2 of 3");
  });

  it("is honest about an empty log", () => {
    renderWithStream(<EventLog runId={RUN_ID} />);

    expect(screen.getByRole("region", { name: "Event log" })).toHaveTextContent("0 events loaded");
  });
});

describe("ScenarioList slot", () => {
  it("names its region and shows the counters of the cached run", () => {
    renderWithStream(<ScenarioList runId={RUN_ID} />, {
      state: {
        run: makeRun({
          counters: {
            scenarios_total: 12,
            scenarios_done: 5,
            pass: 4,
            fail: 1,
            flaky: 0,
            uncertain: 0,
            skipped: 0,
            steps_recorded: 30,
          },
        }),
      },
    });

    expect(screen.getByRole("region", { name: "Scenarios" })).toHaveTextContent(
      "5 of 12 scenarios done",
    );
  });

  it("says it is loading when there is no run yet", () => {
    renderWithStream(<ScenarioList runId={RUN_ID} />, { state: { run: undefined } });

    expect(screen.getByRole("region", { name: "Scenarios" })).toHaveTextContent(
      "Loading scenarios",
    );
  });
});

describe("TileGrid slot", () => {
  it("says there are no tiles yet while the run is queued", () => {
    serveRun();
    renderWithStream(<TileGrid runId={RUN_ID} />, {
      state: { run: makeRun({ status: "queued" }) },
    });

    expect(screen.getByRole("region", { name: "Live tiles" })).toHaveTextContent(
      "No tiles yet: the run has not started",
    );
  });

  it("counts the browser sessions from the shared sessions query", async () => {
    serveRun({
      sessions: [
        makeBrowserSession(),
        makeBrowserSession({ id: "0198f6f2-8a11-7c33-8e02-19d0a5a7c9c0" }),
      ],
    });
    renderWithStream(<TileGrid runId={RUN_ID} />);

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Live tiles" })).toHaveTextContent(
        "2 browser sessions so far",
      ),
    );
  });
});

describe("StepInspector slot", () => {
  it.each(["drawer", "page"] as const)(
    "keeps its name, props and landmark as the %s variant",
    (variant) => {
      renderWithStream(<StepInspector stepId="step-1" variant={variant} />);

      const region = screen.getByRole("region", { name: /step step-1/i });
      expect(region).toHaveAttribute("data-variant", variant);
    },
  );
});
