import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  booleanParam,
  createSearchParamsCodec,
  enumListParam,
  stringListParam,
  textParam,
} from "@/lib/search-params";
import { useUrlFilters } from "@/lib/url-state";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";
import { resetLocation, setLocationSilently, trackHistory } from "@/tests/utils/fake-navigation";
import { FilterBar, type FilterField } from "./filter-bar";

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

const APP_KINDS = ["web", "api", "llm_assistant"] as const;

const codec = createSearchParamsCodec(
  {
    q: textParam(),
    app_kind: enumListParam(APP_KINDS),
    area: stringListParam(),
    include_archived: booleanParam(),
  },
  { defaults: { include_archived: false } },
);

type Values = ReturnType<typeof codec.parse>;

const FIELDS: readonly FilterField<Extract<keyof Values, string>>[] = [
  { type: "text", key: "q", label: "Search", placeholder: "Name or slug", debounceMs: 20 },
  {
    type: "multi",
    key: "app_kind",
    label: "App kind",
    options: [
      { value: "web", label: "Web app" },
      { value: "api", label: "HTTP API" },
      { value: "llm_assistant", label: "LLM assistant" },
    ],
  },
  { type: "toggle", key: "include_archived", label: "Include archived" },
];

function fieldsWithDebounce(
  debounceMs: number,
): readonly FilterField<Extract<keyof Values, string>>[] {
  return FIELDS.map((field) => (field.type === "text" ? { ...field, debounceMs } : field));
}

function Harness({ debounceMs = 20 }: { debounceMs?: number }) {
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(codec);
  return (
    <>
      <FilterBar
        label="Filter targets"
        fields={fieldsWithDebounce(debounceMs)}
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
      />
      <pre data-testid="values">{JSON.stringify(values)}</pre>
    </>
  );
}

let history: ReturnType<typeof trackHistory>;

beforeEach(() => {
  history = trackHistory();
  resetLocation("/targets");
});

afterEach(() => {
  history.restore();
});

function readValues(): Values {
  return JSON.parse(screen.getByTestId("values").textContent ?? "{}") as Values;
}

describe("FilterBar with URL state", () => {
  it("names the search region, the fields and the live status", () => {
    renderWithProviders(<Harness />);

    expect(screen.getByRole("search", { name: "Filter targets" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAttribute(
      "placeholder",
      "Name or slug",
    );
    expect(screen.getByRole("button", { name: "App kind: any" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Include archived" })).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("No filters active");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("reads the filters from the URL on first render and keeps unrelated keys", async () => {
    resetLocation("/targets?q=bill&app_kind=api&app_kind=web&include_archived=true&tab=plans");
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("bill");
    expect(screen.getByRole("button", { name: "App kind: 2 selected" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Include archived" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("3 filters active");
    expect(readValues()).toEqual({ q: "bill", app_kind: ["web", "api"], include_archived: true });

    await user.click(screen.getByRole("switch", { name: "Include archived" }));

    expect(window.location.search).toBe("?tab=plans&q=bill&app_kind=web&app_kind=api");
  });

  it("debounces typing into one replaceState and never pushes history", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness debounceMs={400} />);

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "gra");

    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("gra");
    expect(history.calls.replace).toEqual([]);
    expect(window.location.search).toBe("");
    await waitFor(() => expect(window.location.search).toBe("?q=gra"));
    expect(history.calls.replace).toEqual(["/targets?q=gra"]);
    expect(history.calls.push).toEqual([]);
    expect(readValues()).toEqual({ q: "gra" });
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("gra");
  });

  it("commits at once on Enter without submitting a page navigation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness debounceMs={5000} />);

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "live{Enter}");

    expect(window.location.search).toBe("?q=live");
    expect(history.calls.replace).toHaveLength(1);
  });

  it("removes the key when the text is cleared", async () => {
    resetLocation("/targets?q=old");
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.clear(screen.getByRole("searchbox", { name: "Search" }));
    await waitFor(() => expect(window.location.search).toBe(""));

    expect(readValues()).toEqual({});
  });

  it("selects several values in a popover group and writes them in option order", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("button", { name: "App kind: any" }));
    const group = await screen.findByRole("group", { name: "App kind" });
    await user.click(within(group).getByRole("checkbox", { name: "HTTP API" }));
    await user.click(within(group).getByRole("checkbox", { name: "Web app" }));

    expect(window.location.search).toBe("?app_kind=web&app_kind=api");
    expect(screen.getByRole("button", { name: "App kind: 2 selected" })).toBeInTheDocument();

    await user.click(within(group).getByRole("checkbox", { name: "Web app" }));
    await user.click(within(group).getByRole("checkbox", { name: "HTTP API" }));

    expect(window.location.search).toBe("");
    expect(readValues()).toEqual({});
  });

  it("toggles a boolean on and removes it when off, since false is the default", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("switch", { name: "Include archived" }));
    expect(window.location.search).toBe("?include_archived=true");
    await user.click(screen.getByRole("switch", { name: "Include archived" }));
    expect(window.location.search).toBe("");
  });

  it("clears only the filter keys, empties pending text and hides the button again", async () => {
    resetLocation("/targets?q=bill&app_kind=api&tab=plans");
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.type(screen.getByRole("searchbox", { name: "Search" }), "x");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(window.location.search).toBe("?tab=plans");
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("No filters active");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    expect(history.calls.push).toEqual([]);
  });

  it("follows the back button", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");

    act(() => {
      setLocationSilently("/targets?q=zzz");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("zzz");
    expect(readValues()).toEqual({ q: "zzz" });
  });

  it("lists a dynamic option set and shows an empty notice", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <FilterBar<Values>
        label="Filter catalog"
        fields={[{ type: "multi", key: "area", label: "Area", options: [] }]}
        values={{}}
        onChange={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Area: any" }));

    expect(await screen.findByText("No options")).toBeInTheDocument();
  });
});
