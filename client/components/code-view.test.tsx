import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/tests/utils/render";
import { CodeView, codeViewHeight } from "./code-view";

describe("CodeView", () => {
  it("renders the value read-only under an accessible name", () => {
    renderWithProviders(
      <CodeView value="SELECT 1;" language="sql" label="Source of open_maintenance" />,
    );

    const editor = screen.getByRole("textbox", { name: "Source of open_maintenance" });
    expect(editor).toHaveValue("SELECT 1;");
    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveAttribute("data-language", "sql");
  });

  it.each([
    ["yaml", ".yaml"],
    ["sql", ".sql"],
    ["python", ".py"],
    ["json", ".json"],
  ] as const)("gives a %s view a path that ends in %s", (language, extension) => {
    renderWithProviders(<CodeView value="x" language={language} label="Code" />);

    expect(screen.getByTestId("code-editor-mock").getAttribute("data-path")).toMatch(
      new RegExp(`^inmemory://code-view/.+\\${extension}$`),
    );
  });

  it("gives two views on one page different paths so they never share a model", () => {
    renderWithProviders(
      <>
        <CodeView value="a" language="sql" label="First" />
        <CodeView value="b" language="sql" label="Second" />
      </>,
    );

    const [first, second] = screen.getAllByTestId("code-editor-mock");
    expect(first?.getAttribute("data-path")).not.toBe(second?.getAttribute("data-path"));
  });

  it("passes the class name to the frame", () => {
    const { container } = renderWithProviders(
      <CodeView value="a" language="json" label="Json" className="max-w-md" />,
    );

    expect(container.querySelector("[data-slot=code-view]")).toHaveClass("max-w-md");
  });
});

describe("codeViewHeight", () => {
  it("grows with the number of lines between a minimum and a maximum", () => {
    expect(codeViewHeight("one line")).toBe("120px");
    expect(codeViewHeight(Array.from({ length: 12 }, () => "x").join("\n"))).toBe("244px");
    expect(codeViewHeight(Array.from({ length: 500 }, () => "x").join("\n"))).toBe("420px");
  });
});
