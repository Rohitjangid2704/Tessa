import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { act, renderWithProviders, screen, userEvent, waitFor } from "@/tests/utils/render";
import {
  DEFAULT_HELLO_INPUT,
  HelloControls,
  VIEWER_START_HINT,
  clampInteger,
} from "./hello-controls";
import type { HelloRunInput } from "./mutations";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function renderControls(overrides: Partial<{ value: HelloRunInput; pending: boolean }> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  renderWithProviders(
    <HelloControls
      value={overrides.value ?? DEFAULT_HELLO_INPUT}
      onChange={onChange}
      onSubmit={onSubmit}
      pending={overrides.pending ?? false}
    />,
  );
  return { onChange, onSubmit };
}

describe("HelloControls as a member", () => {
  beforeEach(async () => {
    await signInAs(MEMBER_USER);
  });

  it("starts disabled until the role is known, then enables", async () => {
    renderControls();
    const button = screen.getByRole("button", { name: /start hello run/i });
    expect(button).toBeDisabled();

    await waitFor(() => expect(button).toBeEnabled());
  });

  it("submits the current values", async () => {
    const { onSubmit } = renderControls({
      value: { ticks: 3, tick_interval_ms: 300, include_laya: false },
    });
    const button = screen.getByRole("button", { name: /start hello run/i });
    await waitFor(() => expect(button).toBeEnabled());

    await userEvent.click(button);

    expect(onSubmit).toHaveBeenCalledWith({ ticks: 3, tick_interval_ms: 300, include_laya: false });
  });

  it("reports edited values clamped to the contract ranges", async () => {
    const changes: HelloRunInput[] = [];
    function Stateful() {
      const [value, setValue] = useState(DEFAULT_HELLO_INPUT);
      return (
        <HelloControls
          value={value}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onSubmit={vi.fn()}
          pending={false}
        />
      );
    }
    renderWithProviders(<Stateful />);

    const ticks = screen.getByLabelText("Ticks");
    await userEvent.clear(ticks);
    await userEvent.type(ticks, "99");
    expect(changes.at(-1)).toEqual({ ...DEFAULT_HELLO_INPUT, ticks: 60 });
    expect(ticks).toHaveValue(99);
    await userEvent.tab();
    expect(ticks).toHaveValue(60);

    const interval = screen.getByLabelText("Interval (ms)");
    await userEvent.clear(interval);
    expect(interval).toHaveValue(null);
    await userEvent.type(interval, "5");
    expect(changes.at(-1)).toEqual({ ...DEFAULT_HELLO_INPUT, ticks: 60, tick_interval_ms: 100 });
  });

  it("toggles Laya through a labelled switch", async () => {
    const { onChange } = renderControls();

    await userEvent.click(screen.getByRole("switch", { name: "Include Laya" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_HELLO_INPUT, include_laya: false });
  });

  it("disables the button and says Starting while the request is pending", async () => {
    renderControls({ pending: true });

    expect(await screen.findByRole("button", { name: "Starting..." })).toBeDisabled();
  });

  it("does not hint about roles", async () => {
    renderControls();
    await waitFor(() => expect(screen.getByRole("button", { name: /start/i })).toBeEnabled());

    expect(screen.queryByText(VIEWER_START_HINT)).not.toBeInTheDocument();
  });
});

describe("HelloControls as a viewer", () => {
  beforeEach(async () => {
    await signInAs(VIEWER_USER);
  });

  it("disables start, explains why in text and never submits", async () => {
    const { onSubmit } = renderControls();

    const hint = await screen.findByText(VIEWER_START_HINT);
    const button = screen.getByRole("button", { name: /start hello run/i });
    expect(hint).toBeVisible();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(VIEWER_START_HINT);

    await userEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the tooltip when the wrapper takes focus", async () => {
    renderControls();
    await screen.findByText(VIEWER_START_HINT);
    const button = screen.getByRole("button", { name: /start hello run/i });

    act(() => button.parentElement?.focus());

    expect(await screen.findByRole("tooltip")).toHaveTextContent(VIEWER_START_HINT);
  });
});

describe("clampInteger", () => {
  const limits = { min: 1, max: 60, fallback: 5 };

  it("clamps, truncates and falls back", () => {
    expect(clampInteger(0, limits)).toBe(1);
    expect(clampInteger(61, limits)).toBe(60);
    expect(clampInteger(7.9, limits)).toBe(7);
    expect(clampInteger(Number.NaN, limits)).toBe(5);
    expect(clampInteger(Number.POSITIVE_INFINITY, limits)).toBe(5);
  });
});
