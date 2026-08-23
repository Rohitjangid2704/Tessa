import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMachineValueVisible,
  resetRevealMachineValue,
  REVEAL_MACHINE_STORAGE_KEY,
  setRevealMachineValue,
  useRevealMachineValue,
} from "./blind-mode";

function Toggle() {
  const [reveal, setReveal] = useRevealMachineValue();
  return (
    <button type="button" onClick={() => setReveal(!reveal)}>
      {reveal ? "revealed" : "blind"}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetRevealMachineValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetRevealMachineValue();
});

describe("isMachineValueVisible", () => {
  it("hides the machine value until the card is answered by default", () => {
    expect(
      isMachineValueVisible({ reason: "uncertain", answered: false, revealBeforeAnswer: false }),
    ).toBe(false);
  });

  it("shows it after the card is answered", () => {
    expect(
      isMachineValueVisible({ reason: "uncertain", answered: true, revealBeforeAnswer: false }),
    ).toBe(true);
  });

  it("shows it before answering when the person turned the toggle on", () => {
    expect(
      isMachineValueVisible({ reason: "judge_flagged", answered: false, revealBeforeAnswer: true }),
    ).toBe(true);
    expect(
      isMachineValueVisible({ reason: "uncertain", answered: false, revealBeforeAnswer: true }),
    ).toBe(true);
  });

  it.each(["audit", "disagreement"] as const)(
    "keeps %s cards blind even with the toggle on, until answered",
    (reason) => {
      expect(isMachineValueVisible({ reason, answered: false, revealBeforeAnswer: true })).toBe(
        false,
      );
      expect(isMachineValueVisible({ reason, answered: true, revealBeforeAnswer: true })).toBe(
        true,
      );
    },
  );
});

describe("useRevealMachineValue", () => {
  it("is blind by default", () => {
    render(<Toggle />);

    expect(screen.getByRole("button")).toHaveTextContent("blind");
  });

  it("stores the choice in localStorage and reads it back on the next mount", async () => {
    const user = userEvent.setup();
    const first = render(<Toggle />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveTextContent("revealed");
    expect(window.localStorage.getItem(REVEAL_MACHINE_STORAGE_KEY)).toBe("yes");

    first.unmount();
    resetRevealMachineValue();
    render(<Toggle />);
    expect(screen.getByRole("button")).toHaveTextContent("revealed");
  });

  it("removes the stored value when the person goes back to blind", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, "yes");
    render(<Toggle />);
    expect(screen.getByRole("button")).toHaveTextContent("revealed");

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("button")).toHaveTextContent("blind");
    expect(window.localStorage.getItem(REVEAL_MACHINE_STORAGE_KEY)).toBeNull();
  });

  it("updates every mounted consumer when the choice changes", () => {
    render(
      <>
        <Toggle />
        <Toggle />
      </>,
    );

    act(() => setRevealMachineValue(true));

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "revealed",
      "revealed",
    ]);
  });

  it("follows a change made in another tab", () => {
    render(<Toggle />);

    act(() => {
      window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, "yes");
      window.dispatchEvent(new StorageEvent("storage", { key: REVEAL_MACHINE_STORAGE_KEY }));
    });

    expect(screen.getByRole("button")).toHaveTextContent("revealed");
  });

  it("stays blind and keeps working in memory when localStorage throws", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Toggle />);
    expect(screen.getByRole("button")).toHaveTextContent("blind");

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("revealed");

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("blind");
  });
});
