import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { diffBundles } from "@/mocks/stage1/diff";
import { signInAs } from "@/tests/utils/api-session";
import { gracieVersion } from "@/tests/utils/bundles";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { BundleDiffView, countChanges } = await import("./bundle-diff-view");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function viewOf(version: 1 | 2) {
  const { bundle } = gracieVersion(version);
  return {
    id: bundle.id,
    target_id: bundle.target_id,
    version: bundle.version,
    validation_status: bundle.validation_status,
  };
}

describe("BundleDiffView against the previous valid version", () => {
  it("shows the server summary, the counts and every feature change", async () => {
    const expected = diffBundles(gracieVersion(2), gracieVersion(1));
    expect(expected.features.length).toBeGreaterThan(0);
    const counts = countChanges(expected.features);

    renderWithProviders(<BundleDiffView bundle={viewOf(2)} />);

    expect(await screen.findByText(expected.summary)).toBeInTheDocument();
    expect(
      screen.getByText(
        `Features: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed.`,
      ),
    ).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Feature changes" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(expected.features.length);
    for (const feature of expected.features) {
      const item = list.querySelector(`[data-feature='${feature.feature_id}']`);
      expect(item).toHaveAttribute("data-change", feature.change);
    }
  });

  it("shows before and after only for the fields that changed", async () => {
    const expected = diffBundles(gracieVersion(2), gracieVersion(1));
    const changed = expected.features.find((feature) => feature.change === "changed");
    expect(changed).toBeDefined();

    renderWithProviders(<BundleDiffView bundle={viewOf(2)} />);

    const list = await screen.findByRole("list", { name: "Feature changes" });
    const item = list.querySelector(`[data-feature='${changed?.feature_id}']`);
    expect(item).not.toBeNull();
    const scope = within(item as HTMLElement);
    expect(scope.getByText(/fields? changed/)).toBeInTheDocument();
    const shown = scope.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(shown).toEqual(changed?.fields_changed);
  });

  it("lets an added feature be opened to see what it is", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BundleDiffView bundle={viewOf(2)} />);

    const list = await screen.findByRole("list", { name: "Feature changes" });
    const added = list.querySelector("[data-change='added']");
    expect(added).not.toBeNull();
    const summary = within(added as HTMLElement).getByText("Show the added feature");

    await user.click(summary);

    expect(added?.querySelector("details")).toHaveAttribute("open");
    expect(added?.querySelector("pre")?.textContent).toContain('"description"');
  });

  it("lists the changed sections and files", async () => {
    const expected = diffBundles(gracieVersion(2), gracieVersion(1));
    expect(expected.sections.length).toBeGreaterThan(0);

    renderWithProviders(<BundleDiffView bundle={viewOf(2)} />);

    const sections = await screen.findByRole("list", { name: "Section changes" });
    expect(within(sections).getAllByRole("listitem")).toHaveLength(expected.sections.length);
    expect(within(sections).getByText(expected.sections[0]?.section ?? "")).toBeInTheDocument();
  });
});

describe("BundleDiffView for a first version", () => {
  it("says there is nothing to compare with and shows no change lists", async () => {
    renderWithProviders(<BundleDiffView bundle={viewOf(1)} />);

    expect(
      await screen.findByText("There is no earlier valid version to compare with."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Feature changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Section changes" })).not.toBeInTheDocument();
  });
});

describe("BundleDiffView compare with selector", () => {
  it("offers the previous valid version and every other version, not the current one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BundleDiffView bundle={viewOf(2)} />);
    await screen.findByText(/Compared with version 1/);

    await user.click(screen.getByRole("combobox", { name: "Compare with" }));

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Previous valid version",
      "Version 1",
    ]);
  });

  it("re-runs the diff against the chosen version", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BundleDiffView bundle={viewOf(1)} />);
    await screen.findByText("There is no earlier valid version to compare with.");

    await user.click(screen.getByRole("combobox", { name: "Compare with" }));
    await user.click(await screen.findByRole("option", { name: "Version 2" }));

    await waitFor(() => expect(screen.getByText(/Compared with version 2/)).toBeInTheDocument());
    const expected = diffBundles(gracieVersion(1), gracieVersion(2));
    const list = screen.getByRole("list", { name: "Feature changes" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(expected.features.length);
  });
});
