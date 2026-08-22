import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { renderWithProviders, screen } from "@/tests/utils/render";
import TargetsPage, { metadata } from "./page";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("next/navigation", async () => await import("@/tests/utils/fake-navigation"));

beforeEach(() => {
  resetLocation("/targets");
});

describe("TargetsPage", () => {
  it("titles the page and lists the targets", async () => {
    await signInAs(MEMBER_USER);
    renderWithProviders(<TargetsPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Targets" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Gracie" })).toBeInTheDocument();
    expect(metadata.title).toBe("Targets");
  });

  it("offers New target in the header to a member", async () => {
    await signInAs(MEMBER_USER);
    renderWithProviders(<TargetsPage />);

    expect(await screen.findByRole("link", { name: "New target" })).toHaveAttribute(
      "href",
      "/targets/new",
    );
  });

  it("hides New target from a viewer", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<TargetsPage />);

    await screen.findByRole("link", { name: "Gracie" });
    expect(screen.queryByRole("link", { name: "New target" })).not.toBeInTheDocument();
  });

  it("never renders its own main landmark because the shell owns it", async () => {
    await signInAs(MEMBER_USER);
    const { container } = renderWithProviders(<TargetsPage />);

    await screen.findByRole("link", { name: "Gracie" });
    expect(container.querySelector("main")).toBeNull();
  });
});
