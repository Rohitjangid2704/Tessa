import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { makeRun } from "@/tests/utils/run-detail-fixtures";
import { renderWithStream } from "@/tests/utils/run-stream-harness";
import { screen, userEvent } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { RunScreen } = await import("./run-screen");

const RUN_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

describe("RunScreen phases", () => {
  it("shows a busy skeleton while loading", () => {
    renderWithStream(<RunScreen runId={RUN_ID} />, { state: { phase: "loading", run: undefined } });

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading the run");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("shows an error state with the request id and a way back for an unknown run", () => {
    const error = new ApiError({
      status: 404,
      code: "not_found",
      message: "Run not found",
      requestId: "req-404",
    });
    renderWithStream(<RunScreen runId={RUN_ID} />, {
      state: { phase: "not_found", run: undefined, error },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Run not found");
    expect(alert).toHaveTextContent("Request ID: req-404");
    expect(screen.getByRole("link", { name: "Back to runs" })).toHaveAttribute("href", "/runs");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the API message and a retry for any other failure", async () => {
    const retry = vi.fn();
    const error = new ApiError({
      status: 500,
      code: "internal_error",
      message: "The server broke",
      requestId: "req-500",
    });
    renderWithStream(<RunScreen runId={RUN_ID} />, {
      state: { phase: "error", run: undefined, error, retry },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the run");
    expect(screen.getByRole("alert")).toHaveTextContent("Request ID: req-500");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders the header and the body once ready", () => {
    renderWithStream(<RunScreen runId={RUN_ID} />, { state: { run: makeRun() } });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Suite run");
    expect(screen.getByRole("tablist", { name: "Run sections" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Live tiles", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scenarios", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Event log", hidden: true })).toBeInTheDocument();
  });

  it("never renders its own main landmark because the shell owns it", () => {
    const { container } = renderWithStream(<RunScreen runId={RUN_ID} />);

    expect(container.querySelector("main")).toBeNull();
  });
});
