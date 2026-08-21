import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import {
  diffArrays,
  differingFields,
  formatJsonValue,
  JsonDiff,
  stableStringify,
} from "./json-diff";

describe("stableStringify", () => {
  it("ignores key order at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it("keeps array order and tells values apart", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify("1")).not.toBe(stableStringify(1));
    expect(stableStringify(undefined)).toBe("undefined");
  });
});

describe("diffArrays", () => {
  it("lists added and removed items by value", () => {
    const delta = diffArrays(["a", "b", { x: 1 }], ["b", "c", { x: 1 }]);

    expect(delta.removed).toEqual(["a"]);
    expect(delta.added).toEqual(["c"]);
    expect(delta.reordered).toBe(false);
  });

  it("flags a pure reorder", () => {
    const delta = diffArrays(["a", "b"], ["b", "a"]);

    expect(delta).toEqual({ added: [], removed: [], reordered: true });
  });
});

describe("differingFields", () => {
  it("names the fields whose values differ, including added and removed keys", () => {
    expect(
      differingFields({ a: 1, b: [1], c: "x", gone: true }, { a: 1, b: [1, 2], c: "x", fresh: 1 }),
    ).toEqual(["b", "fresh", "gone"]);
  });
});

describe("formatJsonValue", () => {
  it("prints text as is and structures as indented JSON", () => {
    expect(formatJsonValue("hello")).toBe("hello");
    expect(formatJsonValue("")).toBe("empty text");
    expect(formatJsonValue(undefined)).toBe("not set");
    expect(formatJsonValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJsonValue(null)).toBe("null");
  });
});

describe("JsonDiff", () => {
  it("shows before and after for a scalar field", () => {
    renderWithProviders(
      <JsonDiff
        before={{ description: "Lists open issues", kind: "read" }}
        after={{ description: "Lists open and closed issues", kind: "read" }}
        fields={["description"]}
      />,
    );

    const field = screen.getByRole("heading", { name: "description" }).closest("section");
    expect(field).not.toBeNull();
    const scope = within(field as HTMLElement);
    expect(scope.getByText("Before")).toBeInTheDocument();
    expect(scope.getByText("Lists open issues")).toBeInTheDocument();
    expect(scope.getByText("After")).toBeInTheDocument();
    expect(scope.getByText("Lists open and closed issues")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "kind" })).not.toBeInTheDocument();
  });

  it("shows array fields as added and removed items with a text marker", () => {
    renderWithProviders(
      <JsonDiff
        before={{ roles: ["guest", "staff"] }}
        after={{ roles: ["guest", "admin"] }}
        fields={["roles"]}
      />,
    );

    const removed = document.querySelector("[data-item='removed']");
    const added = document.querySelector("[data-item='added']");
    expect(removed).toHaveTextContent("Removed:staff");
    expect(added).toHaveTextContent("Added:admin");
    expect(screen.queryByText("guest")).not.toBeInTheDocument();
  });

  it("describes a reordered list instead of showing nothing", () => {
    renderWithProviders(
      <JsonDiff before={{ roles: ["a", "b"] }} after={{ roles: ["b", "a"] }} fields={["roles"]} />,
    );

    expect(screen.getByText("Same items in a different order.")).toBeInTheDocument();
  });

  it("shows a field that exists on one side only", () => {
    renderWithProviders(
      <JsonDiff
        before={{ confirmation: null }}
        after={{ confirmation: "yes" }}
        fields={["confirmation"]}
      />,
    );

    expect(screen.getByText("null")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });

  it("works out the differing fields itself when none are given", () => {
    renderWithProviders(<JsonDiff before={{ a: 1, b: 2 }} after={{ a: 1, b: 3 }} />);

    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["b"]);
  });

  it("says when nothing differs", () => {
    renderWithProviders(<JsonDiff before={{ a: 1 }} after={{ a: 1 }} />);

    expect(screen.getByText("No field differs.")).toBeInTheDocument();
  });

  it("copes with a missing side", () => {
    renderWithProviders(<JsonDiff before={null} after={{ a: 1 }} />);

    expect(screen.getByRole("heading", { name: "a" })).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
  });
});
