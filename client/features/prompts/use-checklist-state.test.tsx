import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKLIST_STEPS,
  CHECKLIST_STORAGE_PREFIX,
  parseCompletedSteps,
  useChecklistState,
} from "./use-checklist-state";

const ISSUE = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11";
const OTHER_ISSUE = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e22";

function stored(issueId: string): string | null {
  return window.localStorage.getItem(`${CHECKLIST_STORAGE_PREFIX}${issueId}`);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CHECKLIST_STEPS", () => {
  it("walks from VS Code to the upload in seven steps", () => {
    expect(CHECKLIST_STEPS.map((step) => step.id)).toEqual([
      "open_vscode",
      "open_project",
      "open_claude_code",
      "paste_prompt",
      "wait_for_folder",
      "zip_folder",
      "upload_zip",
    ]);
  });
});

describe("parseCompletedSteps", () => {
  it("reads known step ids and drops everything else", () => {
    expect(parseCompletedSteps('["open_vscode","nope",3,"zip_folder"]')).toEqual(
      new Set(["open_vscode", "zip_folder"]),
    );
  });

  it("treats missing, malformed and non-array values as nothing done", () => {
    expect(parseCompletedSteps(null)).toEqual(new Set());
    expect(parseCompletedSteps("not json")).toEqual(new Set());
    expect(parseCompletedSteps('{"open_vscode":true}')).toEqual(new Set());
  });
});

describe("useChecklistState", () => {
  it("starts with nothing done", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));

    expect(result.current.completedCount).toBe(0);
    expect(result.current.total).toBe(7);
    expect(result.current.isDone("open_vscode")).toBe(false);
  });

  it("persists a ticked step in localStorage under the issue", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));

    act(() => result.current.setDone("open_vscode", true));
    act(() => result.current.setDone("paste_prompt", true));

    expect(result.current.isDone("open_vscode")).toBe(true);
    expect(result.current.completedCount).toBe(2);
    expect(stored(ISSUE)).toBe('["open_vscode","paste_prompt"]');
  });

  it("keeps the ticks across a remount", () => {
    const first = renderHook(() => useChecklistState(ISSUE));
    act(() => first.result.current.setDone("zip_folder", true));
    first.unmount();

    const second = renderHook(() => useChecklistState(ISSUE));

    expect(second.result.current.isDone("zip_folder")).toBe(true);
  });

  it("keeps each prompt issue separate", () => {
    const first = renderHook(() => useChecklistState(ISSUE));
    const second = renderHook(() => useChecklistState(OTHER_ISSUE));

    act(() => first.result.current.setDone("open_vscode", true));

    expect(first.result.current.completedCount).toBe(1);
    expect(second.result.current.completedCount).toBe(0);
    expect(stored(OTHER_ISSUE)).toBeNull();
  });

  it("updates every mounted view of the same issue", () => {
    const first = renderHook(() => useChecklistState(ISSUE));
    const second = renderHook(() => useChecklistState(ISSUE));

    act(() => first.result.current.setDone("open_project", true));

    expect(second.result.current.isDone("open_project")).toBe(true);
  });

  it("unticks a step and removes the entry once nothing is left", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));
    act(() => result.current.setDone("open_vscode", true));

    act(() => result.current.setDone("open_vscode", false));

    expect(result.current.completedCount).toBe(0);
    expect(stored(ISSUE)).toBeNull();
  });

  it("resets every step", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));
    act(() => result.current.setDone("open_vscode", true));
    act(() => result.current.setDone("upload_zip", true));

    act(() => result.current.reset());

    expect(result.current.completedCount).toBe(0);
    expect(stored(ISSUE)).toBeNull();
  });

  it("ignores a step id it does not know", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));

    act(() => result.current.setDone("made_up", true));

    expect(result.current.completedCount).toBe(0);
    expect(stored(ISSUE)).toBeNull();
  });

  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useChecklistState(ISSUE));

    act(() => {
      window.localStorage.setItem(
        `${CHECKLIST_STORAGE_PREFIX}${ISSUE}`,
        '["open_vscode","open_project"]',
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: `${CHECKLIST_STORAGE_PREFIX}${ISSUE}` }),
      );
    });

    expect(result.current.completedCount).toBe(2);
  });

  it("recovers from a corrupted stored value", () => {
    window.localStorage.setItem(`${CHECKLIST_STORAGE_PREFIX}${ISSUE}`, "{{{");

    const { result } = renderHook(() => useChecklistState(ISSUE));

    expect(result.current.completedCount).toBe(0);
    act(() => result.current.setDone("open_vscode", true));
    expect(result.current.completedCount).toBe(1);
  });

  it("keeps working in memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { result } = renderHook(() => useChecklistState(OTHER_ISSUE));

    act(() => result.current.setDone("open_vscode", true));
    expect(result.current.isDone("open_vscode")).toBe(true);

    act(() => result.current.reset());
    expect(result.current.completedCount).toBe(0);
  });

  it("renders with nothing done on the server", () => {
    window.localStorage.setItem(`${CHECKLIST_STORAGE_PREFIX}${ISSUE}`, '["open_vscode"]');
    function Probe() {
      const state = useChecklistState(ISSUE);
      return <p>{`done:${state.completedCount}`}</p>;
    }

    expect(renderToString(<Probe />)).toContain("done:0");
  });
});
