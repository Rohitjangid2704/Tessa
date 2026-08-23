import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { ConnectPanel, installCommand, marketplaceAddCommand } from "./connect-panel";
import { CONNECT_SECTION_LABEL, ConnectPanelSection } from "./connect-panel-section";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const SOURCE = "https://github.com/acme/tessa";

describe("command builders", () => {
  it("builds the marketplace and install commands", () => {
    expect(marketplaceAddCommand(SOURCE)).toBe(`claude plugin marketplace add ${SOURCE}`);
    expect(installCommand()).toBe("claude plugin install tessa@tessa");
  });

  it("falls back to a placeholder when the plugin source is not configured", () => {
    expect(marketplaceAddCommand(undefined)).toBe("claude plugin marketplace add <plugin source>");
  });
});

describe("ConnectPanel", () => {
  it("lists the three numbered commands, the API URL, the token note and the Windows note", () => {
    renderWithProviders(<ConnectPanel pluginSource={SOURCE} apiUrl="https://tessa.test" />);
    const steps = within(screen.getByRole("list", { name: "Connect steps" })).getAllByRole(
      "listitem",
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent(`claude plugin marketplace add ${SOURCE}`);
    expect(steps[1]).toHaveTextContent("claude plugin install tessa@tessa");
    expect(steps[2]).toHaveTextContent("/tessa:connect");
    expect(screen.getByText("https://tessa.test")).toBeInTheDocument();
    expect(screen.getByText(/operating system credential store/)).toBeInTheDocument();
    expect(screen.getByText("On Windows")).toBeInTheDocument();
    expect(screen.getByText("node", { selector: "code" })).toBeInTheDocument();
  });

  it("copies each command", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectPanel pluginSource={SOURCE} apiUrl="https://tessa.test" />);
    await user.click(screen.getByRole("button", { name: /Copy\s*install command/ }));
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "claude plugin install tessa@tessa",
    );
    await user.click(screen.getByRole("button", { name: /Copy\s*API URL/ }));
    await expect(navigator.clipboard.readText()).resolves.toBe("https://tessa.test");
  });

  it("says where the plugin source comes from when it is not set", () => {
    renderWithProviders(<ConnectPanel pluginSource={undefined} apiUrl="https://tessa.test" />);
    expect(screen.getByText(/NEXT_PUBLIC_PLUGIN_SOURCE is not set/)).toBeInTheDocument();
  });
});

describe("ConnectPanelSection", () => {
  it("is collapsed until the engineer opens it and links to the token page", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectPanelSection pluginSource={SOURCE} apiUrl="https://x.test" />);
    const trigger = screen.getByRole("button", { name: CONNECT_SECTION_LABEL });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Connect Claude Code")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Connect Claude Code")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "create one in Settings" })).toHaveAttribute(
      "href",
      "/settings/tokens",
    );
  });
});
