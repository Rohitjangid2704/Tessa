import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTypingTarget,
  resolveShortcut,
  SHORTCUT_KEYS,
  useLabelShortcuts,
  type ShortcutAction,
  type ShortcutEventLike,
} from "./use-label-shortcuts";

function keyEvent(key: string, overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: document.body,
    ...overrides,
  };
}

describe("resolveShortcut", () => {
  it.each([
    ["p", { kind: "answer", value: "pass" }],
    ["f", { kind: "answer", value: "fail" }],
    ["u", { kind: "answer", value: "uncertain" }],
    ["s", { kind: "skip" }],
    ["o", { kind: "open" }],
    ["z", { kind: "undo" }],
    ["?", { kind: "help" }],
  ] satisfies Array<[string, ShortcutAction]>)("maps %s to its action", (key, action) => {
    expect(resolveShortcut(keyEvent(key, { shiftKey: key === "?" }))).toEqual(action);
  });

  it("accepts an upper-case letter when caps lock is on", () => {
    expect(resolveShortcut(keyEvent("P"))).toEqual({ kind: "answer", value: "pass" });
  });

  it("ignores keys that are not shortcuts", () => {
    for (const key of ["a", "Enter", " ", "Escape", "1", "constructor"]) {
      expect(resolveShortcut(keyEvent(key))).toBeNull();
    }
  });

  it.each(["ctrlKey", "metaKey", "altKey"] as const)(
    "ignores a key pressed with %s",
    (modifier) => {
      expect(resolveShortcut(keyEvent("p", { [modifier]: true }))).toBeNull();
      expect(resolveShortcut(keyEvent("?", { [modifier]: true, shiftKey: true }))).toBeNull();
    },
  );

  it("ignores a letter pressed with shift, but not the question mark", () => {
    expect(resolveShortcut(keyEvent("P", { shiftKey: true }))).toBeNull();
    expect(resolveShortcut(keyEvent("?", { shiftKey: true }))).toEqual({ kind: "help" });
  });

  it("ignores a held key and a key another handler already used", () => {
    expect(resolveShortcut(keyEvent("p", { repeat: true }))).toBeNull();
    expect(resolveShortcut(keyEvent("p", { defaultPrevented: true }))).toBeNull();
  });

  it("exposes the key of every shortcut", () => {
    expect(Object.values(SHORTCUT_KEYS)).toEqual(["p", "f", "u", "s", "o", "z", "?"]);
  });
});

describe("isTypingTarget", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function target(html: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const element = host.querySelector("[data-target]");
    if (element === null) {
      throw new Error("missing target");
    }
    return element;
  }

  it.each([
    ["an input", "<input data-target />"],
    ["a textarea", "<textarea data-target></textarea>"],
    ["a select", "<select data-target><option>a</option></select>"],
    ["a contenteditable element", '<div contenteditable="true"><span data-target>x</span></div>'],
    ["a textbox role", '<div role="textbox" data-target></div>'],
    ["a listbox option", '<div role="listbox"><div role="option" data-target>x</div></div>'],
    ["a menu item", '<div role="menu"><div role="menuitem" data-target>x</div></div>'],
    ["a dialog", '<div role="dialog"><button data-target>x</button></div>'],
    ["a combobox", '<button role="combobox" data-target>x</button>'],
  ])("treats %s as typing", (_name, html) => {
    expect(isTypingTarget(target(html))).toBe(true);
  });

  it("does not treat a plain button, the body or no target as typing", () => {
    expect(isTypingTarget(target("<button data-target>x</button>"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("makes resolveShortcut ignore a key typed in a field", () => {
    expect(resolveShortcut(keyEvent("p", { target: target("<input data-target />") }))).toBeNull();
  });
});

describe("useLabelShortcuts", () => {
  function Harness({
    onAction,
    enabled = true,
  }: {
    onAction: (action: ShortcutAction) => void;
    enabled?: boolean;
  }) {
    useLabelShortcuts(onAction, enabled);
    return (
      <div>
        <input aria-label="note" />
        <button type="button">go</button>
      </div>
    );
  }

  it("calls the handler for a shortcut and prevents the default", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);

    const notPrevented = fireEvent.keyDown(document.body, { key: "f" });

    expect(onAction).toHaveBeenCalledWith({ kind: "answer", value: "fail" });
    expect(notPrevented).toBe(false);
  });

  it("works while a button has focus", () => {
    const onAction = vi.fn();
    const { getByRole } = render(<Harness onAction={onAction} />);

    fireEvent.keyDown(getByRole("button", { name: "go" }), { key: "s" });

    expect(onAction).toHaveBeenCalledWith({ kind: "skip" });
  });

  it("ignores keys typed into a field", () => {
    const onAction = vi.fn();
    const { getByLabelText } = render(<Harness onAction={onAction} />);

    fireEvent.keyDown(getByLabelText("note"), { key: "p" });

    expect(onAction).not.toHaveBeenCalled();
  });

  it("ignores modifier keys and repeats", () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);

    fireEvent.keyDown(document.body, { key: "p", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "p", metaKey: true });
    fireEvent.keyDown(document.body, { key: "p", altKey: true });
    fireEvent.keyDown(document.body, { key: "p", repeat: true });

    expect(onAction).not.toHaveBeenCalled();
  });

  it("does nothing while disabled and starts again when enabled", () => {
    const onAction = vi.fn();
    const { rerender } = render(<Harness onAction={onAction} enabled={false} />);

    fireEvent.keyDown(document.body, { key: "p" });
    expect(onAction).not.toHaveBeenCalled();

    rerender(<Harness onAction={onAction} enabled />);
    fireEvent.keyDown(document.body, { key: "p" });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest handler and stops listening on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(<Harness onAction={first} />);

    rerender(<Harness onAction={second} />);
    fireEvent.keyDown(document.body, { key: "u" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ kind: "answer", value: "uncertain" });

    unmount();
    fireEvent.keyDown(document.body, { key: "u" });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
