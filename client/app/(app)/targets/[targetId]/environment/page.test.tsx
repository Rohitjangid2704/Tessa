import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen } from "@/tests/utils/render";
import EnvironmentPage, { metadata } from "./page";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

async function renderPage(targetId: string) {
  const page = await EnvironmentPage({
    params: Promise.resolve({ targetId }),
    searchParams: Promise.resolve({}),
  });
  return renderWithProviders(page);
}

describe("EnvironmentPage", () => {
  it("titles the tab and renders the environment of the target in the path", async () => {
    await renderPage(STAGE_ONE_IDS.gracie);

    expect(metadata.title).toBe("Environment");
    expect(await screen.findByRole("form", { name: "Environment variables" })).toBeInTheDocument();
    expect(screen.getByLabelText("GRACIE_API_URL")).toHaveValue(
      "https://gracie-api.qa.example.test",
    );
  });

  it("never renders its own heading level one or main landmark because the layout owns them", async () => {
    const { container } = await renderPage(STAGE_ONE_IDS.gracie);

    await screen.findByRole("form", { name: "Environment variables" });
    expect(container.querySelector("main")).toBeNull();
    expect(container.querySelector("h1")).toBeNull();
  });
});
