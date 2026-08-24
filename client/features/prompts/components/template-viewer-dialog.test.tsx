import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMBER_USER } from "@/mocks/factories/users";
import { signInAs } from "@/tests/utils/api-session";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import { server } from "@/tests/utils/server";
import { TemplateViewerDialog, templateTitle } from "./template-viewer-dialog";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

beforeEach(async () => {
  await signInAs(MEMBER_USER);
});

async function openDialog(name: "discovery" | "fixup", version?: number) {
  const user = userEvent.setup();
  renderWithProviders(<TemplateViewerDialog name={name} version={version} />);
  await user.click(screen.getByRole("button", { name: /View template/ }));
  return { user, dialog: await screen.findByRole("dialog", { name: templateTitle(name) }) };
}

function textOf(dialog: HTMLElement): HTMLTextAreaElement {
  return within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "Template text" });
}

describe("TemplateViewerDialog", () => {
  it("titles the dialog after the template", () => {
    expect(templateTitle("discovery")).toBe("Discovery template");
    expect(templateTitle("fixup")).toBe("Fixup template");
  });

  it("labels the trigger with the version when one is given", () => {
    renderWithProviders(<TemplateViewerDialog name="discovery" version={1} />);

    expect(screen.getByRole("button", { name: "View template v1" })).toBeInTheDocument();
  });

  it("shows the current template read-only with its variables", async () => {
    const { dialog } = await openDialog("discovery");

    await within(dialog).findByRole("textbox", { name: "Template text" });
    const area = textOf(dialog);
    expect(area).toHaveAttribute("readonly");
    expect(area.value).toContain("{{SCHEMA_URL}}");
    expect(area.value).toContain("Format conventions");
    for (const variable of ["SCHEMA_URL", "TARGET_TOKEN", "APP_KIND_HINTS"]) {
      expect(within(dialog).getByText(`{{${variable}}}`)).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("combobox", { name: "Template version" })).toHaveTextContent(
      "Version 2 (latest)",
    );
  });

  it("opens on the version that produced a prompt", async () => {
    const { dialog } = await openDialog("discovery", 1);

    await within(dialog).findByRole("textbox", { name: "Template text" });
    expect(textOf(dialog).value).not.toContain("Format conventions");
    expect(within(dialog).getByRole("combobox", { name: "Template version" })).toHaveTextContent(
      "Version 1",
    );
  });

  it("switches between versions", async () => {
    const { user, dialog } = await openDialog("discovery", 1);
    await within(dialog).findByRole("textbox", { name: "Template text" });

    await user.click(within(dialog).getByRole("combobox", { name: "Template version" }));
    await user.click(await screen.findByRole("option", { name: "Version 2 (latest)" }));

    await within(dialog).findByDisplayValue(/Format conventions/);
    expect(textOf(dialog).value).toContain("Format conventions");
  });

  it("shows the fix-up template with its own variables", async () => {
    const { dialog } = await openDialog("fixup");

    await within(dialog).findByRole("textbox", { name: "Template text" });
    expect(within(dialog).getByText("{{FIXUP_ITEMS}}")).toBeInTheDocument();
    expect(within(dialog).getByText("{{BUNDLE_VERSION}}")).toBeInTheDocument();
  });

  it("shows a loading state and then a retry when the template fails to load", async () => {
    server.use(
      http.get(
        "*/api/v1/prompt-templates/:name",
        () =>
          HttpResponse.json(
            {
              error: {
                code: "not_found",
                message: "Prompt template not found",
                request_id: "req-1112223",
                details: [],
              },
            },
            { status: 404 },
          ),
        { once: true },
      ),
    );
    const { user, dialog } = await openDialog("discovery");

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the template");
    expect(alert).toHaveTextContent("req-1112223");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await within(dialog).findByRole("textbox", { name: "Template text" });
  });

  it("copies the template text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user, dialog } = await openDialog("discovery");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await within(dialog).findByRole("textbox", { name: "Template text" });

    await user.click(within(dialog).getByRole("button", { name: "Copy template text" }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain("{{TARGET_TOKEN}}");
  });
});
