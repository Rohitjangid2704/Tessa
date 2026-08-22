import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { makeRun, RUN_ID, serveRun, tickEvents } from "@/tests/utils/run-detail-fixtures";
import { knownEnvelope } from "@/tests/utils/stream-fixtures";
import { renderWithProviders, screen } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { default: RunLayout } = await import("./layout");
const { default: RunPage, metadata } = await import("./page");
const { default: RunDefault } = await import("./default");
const { default: DrawerDefault } = await import("./@drawer/default");
const { default: RunSegmentLoading } = await import("./loading");
const { default: RunSegmentNotFound } = await import("./not-found");
const { useRunStream } = await import("@/features/runs/use-run-stream");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function params(runId: string = RUN_ID) {
  return Promise.resolve({ runId });
}

function Probe() {
  const { phase, runId } = useRunStream();
  return (
    <p data-testid="probe">
      {runId} {phase}
    </p>
  );
}

function serveFinishedRun() {
  return serveRun({
    run: makeRun({ status: "completed", finished_at: "2026-09-30T14:10:00.000Z" }),
    events: [...tickEvents(2), knownEnvelope("run.finished", 3)],
  });
}

describe("run layout", () => {
  it("gives its children and the drawer slot one stream provider for the run in the path", async () => {
    serveFinishedRun();
    const layout = await RunLayout({
      children: <Probe />,
      drawer: <p>drawer slot content</p>,
      params: params(),
    });

    renderWithProviders(layout);

    expect(screen.getByText("drawer slot content")).toBeInTheDocument();
    expect(await screen.findByText(`${RUN_ID} ready`)).toBeInTheDocument();
  });

  it("renders the drawer slot even while the run is loading", async () => {
    serveFinishedRun();
    const layout = await RunLayout({
      children: <Probe />,
      drawer: <p>drawer slot content</p>,
      params: params(),
    });

    renderWithProviders(layout);

    expect(screen.getByTestId("probe")).toHaveTextContent("loading");
    expect(screen.getByText("drawer slot content")).toBeInTheDocument();
    await screen.findByText(`${RUN_ID} ready`);
  });
});

describe("run page", () => {
  it("titles the tab and renders the run header and body for the run in the path", async () => {
    serveFinishedRun();
    const layout = await RunLayout({
      children: await RunPage({ params: params(), searchParams: Promise.resolve({}) }),
      drawer: null,
      params: params(),
    });

    const { container } = renderWithProviders(layout);

    expect(metadata.title).toBe("Run");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Suite run");
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(container.querySelector("main")).toBeNull();
  });

  it("shows the not found state for an unknown run", async () => {
    serveRun({ run: null });
    const layout = await RunLayout({
      children: await RunPage({ params: params(), searchParams: Promise.resolve({}) }),
      drawer: null,
      params: params(),
    });

    renderWithProviders(layout);

    expect(await screen.findByRole("alert")).toHaveTextContent("Run not found");
  });

  it("falls back to the same page content from default.tsx", async () => {
    serveFinishedRun();
    const layout = await RunLayout({
      children: await RunDefault({ params: params(), searchParams: Promise.resolve({}) }),
      drawer: null,
      params: params(),
    });

    renderWithProviders(layout);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Suite run");
  });
});

describe("run segment files", () => {
  it("renders nothing for the drawer fallback", () => {
    expect(DrawerDefault()).toBeNull();
  });

  it("shows a busy skeleton from loading.tsx", () => {
    renderWithProviders(<RunSegmentLoading />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });

  it("shows the not found error from not-found.tsx with a way back", () => {
    renderWithProviders(<RunSegmentNotFound />);

    expect(screen.getByRole("alert")).toHaveTextContent("Run not found");
    expect(screen.getByRole("link", { name: "Back to runs" })).toHaveAttribute("href", "/runs");
  });
});
