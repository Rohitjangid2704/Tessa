import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { BundleSourceChips, NO_SOURCE_RECORDED } from "./bundle-source-chips";

const FULL_SHA = "9f3c2a1b7d8e4f60a5b1c2d3e4f5a6b7c8d9e0f1";

describe("BundleSourceChips", () => {
  it("shows the first seven characters of the commit and the branch", () => {
    renderWithProviders(<BundleSourceChips bundle={{ commit_sha: FULL_SHA, branch: "main" }} />);

    expect(screen.getByText("9f3c2a1")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByText(NO_SOURCE_RECORDED)).not.toBeInTheDocument();
  });

  it("shows the full commit on hover", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BundleSourceChips bundle={{ commit_sha: FULL_SHA, branch: null }} />);

    await user.hover(screen.getByText("9f3c2a1"));

    expect(await screen.findByRole("tooltip")).toHaveTextContent(FULL_SHA);
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("shows a branch alone", () => {
    renderWithProviders(<BundleSourceChips bundle={{ commit_sha: null, branch: "qa/bundle" }} />);

    expect(screen.getByText("qa/bundle")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Commit /)).not.toBeInTheDocument();
  });

  it("says no source was recorded when both are null or absent", () => {
    const first = renderWithProviders(
      <BundleSourceChips bundle={{ commit_sha: null, branch: null }} />,
    );
    expect(screen.getByText(NO_SOURCE_RECORDED)).toBeInTheDocument();
    first.unmount();

    renderWithProviders(<BundleSourceChips bundle={{}} />);
    expect(screen.getByText(NO_SOURCE_RECORDED)).toBeInTheDocument();
  });
});
