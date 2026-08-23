import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { gracieVersion } from "@/tests/utils/bundles";
import { server } from "@/tests/utils/server";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const { FilePreview, pickDefaultPreview } = await import("./file-preview");

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

function bundleId(): string {
  return gracieVersion(2).bundle.id;
}

describe("pickDefaultPreview", () => {
  it("prefers the manifest, then the first file, then nothing", () => {
    const entry = (path: string) => ({ path, size_bytes: 1, sha256: "x" });

    expect(pickDefaultPreview([entry("README.md"), entry("manifest.yaml")])).toBe("manifest.yaml");
    expect(pickDefaultPreview([entry("README.md"), entry("env.template")])).toBe("README.md");
    expect(pickDefaultPreview([])).toBeNull();
  });
});

describe("FilePreview", () => {
  it("lists the stored files with sizes and opens the manifest first", async () => {
    renderWithProviders(<FilePreview bundleId={bundleId()} />);

    const table = await screen.findByRole("table", { name: "Stored files" });
    const paths = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(paths).toEqual(gracieVersion(2).files.map((file) => file.path));
    expect(
      screen.getByText(
        `${gracieVersion(2).files.length} stored files. Text files can be previewed.`,
      ),
    ).toBeInTheDocument();
    const preview = await screen.findByRole("heading", { level: 3, name: "manifest.yaml" });
    expect(preview).toBeInTheDocument();
    expect(await screen.findByText(/^schema:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview manifest.yaml" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("previews another file chosen from the list, including files in folders", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FilePreview bundleId={bundleId()} />);
    await screen.findByRole("table", { name: "Stored files" });

    await user.click(screen.getByRole("button", { name: "Preview seeds/reset.sql" }));

    expect(
      await screen.findByRole("heading", { level: 3, name: "seeds/reset.sql" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/TRUNCATE guest_requests/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview seeds/reset.sql" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Preview manifest.yaml" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("states that a truncated preview is cut", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FilePreview bundleId={bundleId()} />);
    await screen.findByRole("table", { name: "Stored files" });

    await user.click(screen.getByRole("button", { name: "Preview openapi.json" }));

    const notice = await screen.findByRole("note");
    expect(notice).toHaveTextContent("This preview is truncated.");
    expect(notice).toHaveTextContent("The stored file is 3.5 MiB");
  });

  it("does not show the notice for a complete file", async () => {
    renderWithProviders(<FilePreview bundleId={bundleId()} />);

    await screen.findByText(/^schema:/);

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("says a file without a preview has none and keeps the list usable", async () => {
    server.use(
      http.get("*/api/v1/bundles/:bundle_id/files/*", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "no such file", request_id: "r1", details: [] } },
          { status: 404 },
        ),
      ),
    );
    renderWithProviders(<FilePreview bundleId={bundleId()} />);

    expect(
      await screen.findByRole("heading", { name: "This file has no preview" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Stored files" })).toBeInTheDocument();
  });

  it("shows an error with a retry when the list cannot be loaded", async () => {
    server.use(
      http.get("*/api/v1/bundles/:bundle_id/files", () =>
        HttpResponse.json(
          { error: { code: "internal_error", message: "boom", request_id: "r2", details: [] } },
          { status: 500 },
        ),
      ),
    );
    renderWithProviders(<FilePreview bundleId={bundleId()} />);

    expect(
      await screen.findByRole("heading", { name: "Could not load the file list" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Request ID: r2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
