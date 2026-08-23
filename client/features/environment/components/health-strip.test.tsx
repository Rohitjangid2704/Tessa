import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildHealthReport, buildHealthReportInterface } from "@/mocks/factories/environment";
import { HealthStrip, summarizeHealth } from "./health-strip";

const CHECKED_AT = "2026-09-29T08:45:00.000Z";

function row(name: string): HTMLElement {
  return document.querySelector(`[data-interface="${name}"]`) as HTMLElement;
}

describe("HealthStrip", () => {
  it("says that no check has run yet and shows no list", () => {
    render(<HealthStrip report={buildHealthReport({ checked_at: null, interfaces: [] })} />);

    expect(screen.getByText("No health check has run yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Interface health" })).not.toBeInTheDocument();
  });

  it("shows an ok interface with its latency and message", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({
              interface_id: "rest_api",
              kind: "http",
              status: "ok",
              latency_ms: 42,
              message: "HTTP 200",
              variables: ["APP_API_URL"],
            }),
          ],
        })}
      />,
    );

    const item = row("rest_api");
    expect(within(item).getByText("OK")).toBeInTheDocument();
    expect(within(item).getByText("42 ms")).toBeInTheDocument();
    expect(within(item).getByText("HTTP 200")).toBeInTheDocument();
    expect(within(item).getByText("http")).toBeInTheDocument();
    expect(within(item).getByText("APP_API_URL")).toBeInTheDocument();
    expect(item).toHaveAttribute("data-status", "ok");
  });

  it("shows why an interface failed in the failure tone", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({
              interface_id: "events_sse",
              kind: "sse",
              status: "failed",
              latency_ms: null,
              message: "Connection refused or host unreachable",
            }),
          ],
        })}
      />,
    );

    const item = row("events_sse");
    expect(within(item).getByText("Failed")).toBeInTheDocument();
    expect(within(item).getByText("Connection refused or host unreachable")).toHaveClass(
      "text-destructive",
    );
    expect(within(item).queryByText(/ ms$/)).not.toBeInTheDocument();
  });

  it("shows the reason an interface was skipped", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({
              interface_id: "ops_webhook",
              kind: "webhook",
              status: "skipped",
              latency_ms: null,
              message: "No value set for APP_OPS_HOOK_URL",
            }),
          ],
        })}
      />,
    );

    const item = row("ops_webhook");
    expect(within(item).getByText("Skipped")).toBeInTheDocument();
    expect(within(item).getByText("No value set for APP_OPS_HOOK_URL")).not.toHaveClass(
      "text-destructive",
    );
  });

  it("shows an interface that was never checked", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({
              interface_id: "browser",
              kind: "browser",
              status: "unchecked",
              latency_ms: null,
              message: null,
            }),
          ],
        })}
      />,
    );

    expect(within(row("browser")).getByText("Unchecked")).toBeInTheDocument();
  });

  it("labels a truth source and keeps its prefixed id", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({
              interface_id: "truth:gracie_db",
              kind: "truth_source",
              status: "ok",
              message: "SELECT 1 succeeded",
            }),
          ],
        })}
      />,
    );

    expect(within(row("truth:gracie_db")).getByText("truth source")).toBeInTheDocument();
  });

  it("summarises the ticks and shows when the last check ran", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: [
            buildHealthReportInterface({ interface_id: "a", status: "ok" }),
            buildHealthReportInterface({ interface_id: "b", status: "ok" }),
            buildHealthReportInterface({ interface_id: "c", status: "failed" }),
            buildHealthReportInterface({ interface_id: "d", status: "skipped" }),
          ],
        })}
      />,
    );

    expect(screen.getByText(/Last checked/)).toHaveTextContent("2 ok, 1 failed, 1 skipped");
    expect(document.querySelector("time")).toHaveAttribute("datetime", CHECKED_AT);
  });

  it("marks the strip busy while a run is in progress without dimming its text", () => {
    const { container } = render(
      <HealthStrip report={buildHealthReport({ checked_at: CHECKED_AT })} isRunning />,
    );

    expect(container.querySelector("[data-slot=health-strip]")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(container.querySelector("[data-slot=health-strip]")).not.toHaveClass("opacity-60");
  });

  it("names every tick in words so color is never the only cue", () => {
    render(
      <HealthStrip
        report={buildHealthReport({
          checked_at: CHECKED_AT,
          interfaces: (["ok", "failed", "skipped", "unchecked"] as const).map((status) =>
            buildHealthReportInterface({ interface_id: `i_${status}`, status }),
          ),
        })}
      />,
    );

    expect(
      within(screen.getByRole("list", { name: "Interface health" }))
        .getAllByRole("listitem")
        .map((item) => item.querySelector("[data-slot=status-badge]")?.textContent),
    ).toEqual(["OK", "Failed", "Skipped", "Unchecked"]);
  });
});

describe("summarizeHealth", () => {
  it("lists only the states that occur, in a fixed order", () => {
    expect(
      summarizeHealth([
        buildHealthReportInterface({ status: "skipped" }),
        buildHealthReportInterface({ status: "ok" }),
        buildHealthReportInterface({ status: "unchecked" }),
      ]),
    ).toBe("1 ok, 1 skipped, 1 unchecked");
  });

  it("says nothing was checked for an empty list", () => {
    expect(summarizeHealth([])).toBe("nothing checked");
  });
});
