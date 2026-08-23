import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseStreamMessage, type KnownStreamEvent } from "@/features/streams/events";
import {
  heartbeatEnvelope,
  helloEnvelope,
  knownEnvelope,
  tickEnvelope,
} from "@/tests/utils/stream-fixtures";
import { HelloEventList, shouldListEvent } from "./hello-event-list";
import { HelloStatus } from "./hello-status";

function known(wire: Parameters<typeof parseStreamMessage>[0]): KnownStreamEvent {
  const parsed = parseStreamMessage(wire);
  if (parsed.kind !== "known") {
    throw new Error("fixture is not a known event");
  }
  return parsed.event;
}

describe("HelloEventList", () => {
  it("says there are no events yet", () => {
    render(<HelloEventList events={[]} />);

    expect(screen.getByTestId("hello-empty")).toHaveTextContent("No events yet.");
  });

  it("lists events in the order given with their seq, type, description and UTC time", () => {
    render(
      <HelloEventList
        events={[
          known(helloEnvelope()),
          known(knownEnvelope("run.created", 1)),
          known(tickEnvelope(2, 3)),
        ]}
      />,
    );

    const items = within(screen.getByRole("list", { name: "Run events" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-event-type"))).toEqual([
      "stream.hello",
      "run.created",
      "hello.tick",
    ]);
    expect(items[0]).toHaveTextContent("stream");
    expect(items[1]).toHaveTextContent("#1");
    expect(items[2]).toHaveTextContent("#2");
    expect(items[2]).toHaveTextContent("Tick 2 of 3");
    expect(items[2]).toHaveTextContent("14:03:22.123 UTC");
    expect(items[2]?.querySelector("time")).toHaveAttribute("datetime", "2026-09-30T14:03:22.123Z");
  });

  it("filters heartbeats and keeps everything else", () => {
    expect(shouldListEvent(known(heartbeatEnvelope()))).toBe(false);
    expect(shouldListEvent(known(tickEnvelope(1)))).toBe(true);
    expect(shouldListEvent(known(helloEnvelope()))).toBe(true);
  });
});

describe("HelloStatus", () => {
  it("shows the live indicator, the title, the run id and the last seq", () => {
    render(
      <HelloStatus phase={{ kind: "streaming" }} liveState="live" runId="run-abc" lastSeq={4} />,
    );

    expect(screen.getByRole("status")).toHaveAttribute("data-state", "live");
    expect(screen.getByTestId("hello-phase")).toHaveTextContent("Streaming");
    expect(screen.getByTestId("hello-run-id")).toHaveTextContent("run-abc");
    expect(screen.getByTestId("hello-last-seq")).toHaveTextContent("last seq 4");
  });

  it("names the dependency in the unavailable alert", () => {
    render(
      <HelloStatus
        phase={{ kind: "unavailable", dependency: "temporal", message: "Temporal is not running" }}
        liveState="error"
        runId={null}
        lastSeq={null}
      />,
    );

    const alert = screen.getByTestId("hello-unavailable");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Temporal is not running");
    expect(alert).toHaveTextContent("could not reach temporal");
  });

  it("falls back to a generic dependency name", () => {
    render(
      <HelloStatus
        phase={{ kind: "unavailable", dependency: null, message: "Service unavailable" }}
        liveState="error"
        runId={null}
        lastSeq={null}
      />,
    );

    expect(screen.getByTestId("hello-unavailable")).toHaveTextContent("a dependency");
  });

  it("shows the reconnect attempt", () => {
    render(
      <HelloStatus
        phase={{ kind: "reconnecting", attempt: 3, detail: "The connection was lost" }}
        liveState="reconnecting"
        runId="r"
        lastSeq={9}
      />,
    );

    expect(screen.getByText("Attempt 3. The connection was lost.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "reconnecting");
  });

  it("explains resyncing and finished", () => {
    const { rerender } = render(
      <HelloStatus phase={{ kind: "resyncing" }} liveState="reconnecting" runId="r" lastSeq={1} />,
    );
    expect(screen.getByText(/event log is being reloaded/i)).toBeInTheDocument();

    rerender(<HelloStatus phase={{ kind: "finished" }} liveState="closed" runId="r" lastSeq={7} />);
    expect(screen.getByText(/stream is closed/i)).toBeInTheDocument();
  });

  it("shows a failure alert with the message", () => {
    render(
      <HelloStatus
        phase={{ kind: "failed", message: "This run was not found" }}
        liveState="error"
        runId="r"
        lastSeq={null}
      />,
    );

    expect(screen.getByTestId("hello-failed")).toHaveTextContent("This run was not found");
    expect(screen.queryByTestId("hello-last-seq")).not.toBeInTheDocument();
  });
});
