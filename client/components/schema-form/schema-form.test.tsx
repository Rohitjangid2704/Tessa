import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import { renderWithProviders, screen, userEvent, within } from "@/tests/utils/render";
import type { JsonObject } from "@/lib/schema/subset";
import { SchemaForm } from "./schema-form";
import { useSchemaForm } from "./use-schema-form";

vi.setConfig({ testTimeout: 20_000 });

const SCHEMA = {
  type: "object",
  required: ["tenant_id", "as_of", "role"],
  additionalProperties: false,
  properties: {
    tenant_id: {
      type: "string",
      title: "Tenant",
      description: "Property id the query is scoped to",
      minLength: 3,
      default: "gracie-demo",
    },
    as_of: { type: "string", format: "date", title: "As of", default: "2026-10-01" },
    role: { type: "string", title: "Role", enum: ["front_desk", "manager"], default: "front_desk" },
    limit: { type: "integer", title: "Row limit", minimum: 1, maximum: 200 },
    ratio: { type: "number", title: "Ratio" },
    include_closed: { type: "boolean", title: "Include closed" },
    level: { type: "integer", title: "Level", enum: [1, 2, 3] },
  },
};

const RAW_SCHEMA = {
  type: "object",
  required: ["severities"],
  properties: { severities: { type: "array", items: { type: "string" } } },
};

interface HarnessProps {
  schema: unknown;
  onSubmit: (value: JsonObject) => void;
  initialValue?: JsonObject;
  disabled?: boolean;
}

function Harness({ schema, onSubmit, initialValue, disabled }: HarnessProps) {
  const form = useSchemaForm({ schema, initialValue });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = form.submit();
        if (value !== null) {
          onSubmit(value);
        }
      }}
    >
      <SchemaForm
        schema={schema}
        draft={form.draft}
        onDraftChange={form.setDraft}
        errors={form.errors}
        disabled={disabled}
        legend="Parameters"
      />
      <button type="submit">Submit</button>
      <button
        type="button"
        onClick={() =>
          form.applyServerError(
            new ApiError({
              status: 422,
              code: "validation_failed",
              message: "Request validation failed",
              details: [
                {
                  loc: ["body", "params", "tenant_id"],
                  code: "string_too_short",
                  message: "String should have at least 3 characters",
                },
                {
                  loc: ["body", "params", "unknown_param"],
                  code: "extra_forbidden",
                  message: "Extra inputs are not permitted",
                },
              ],
            }),
          )
        }
      >
        Server rejects
      </button>
    </form>
  );
}

function renderHarness(props: Partial<HarnessProps> = {}) {
  const onSubmit = vi.fn();
  renderWithProviders(<Harness schema={SCHEMA} onSubmit={onSubmit} {...props} />);
  return { onSubmit, user: userEvent.setup() };
}

describe("SchemaForm field types", () => {
  it("renders one labelled control per supported type with defaults filled in", () => {
    renderHarness();

    expect(screen.getByRole("group", { name: "Parameters" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Tenant/)).toHaveValue("gracie-demo");
    expect(screen.getByLabelText(/^As of/)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(/^As of/)).toHaveValue("2026-10-01");
    expect(screen.getByRole("combobox", { name: /^Role/ })).toHaveTextContent("front_desk");
    expect(screen.getByLabelText(/^Row limit/)).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByLabelText(/^Ratio/)).toHaveAttribute("inputmode", "decimal");
    expect(screen.getByRole("switch", { name: /^Include closed/ })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: /^Level/ })).toHaveTextContent("Not set");
  });

  it("marks required fields and links descriptions to their controls", () => {
    renderHarness();

    expect(screen.getByLabelText(/^Tenant/)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/^Row limit/)).toHaveAttribute("aria-required", "false");
    const description = screen.getByText("Property id the query is scoped to");
    expect(screen.getByLabelText(/^Tenant/)).toHaveAttribute("aria-describedby", description.id);
  });

  it("submits a typed value built from what the user entered", async () => {
    const { onSubmit, user } = renderHarness();

    await user.clear(screen.getByLabelText(/^Tenant/));
    await user.type(screen.getByLabelText(/^Tenant/), "hotel-one");
    await user.type(screen.getByLabelText(/^Row limit/), "25");
    await user.type(screen.getByLabelText(/^Ratio/), "0.5");
    await user.click(screen.getByRole("switch", { name: /^Include closed/ }));
    await user.click(screen.getByRole("combobox", { name: /^Role/ }));
    await user.click(await screen.findByRole("option", { name: "manager" }));
    await user.click(screen.getByRole("combobox", { name: /^Level/ }));
    await user.click(await screen.findByRole("option", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledWith({
      tenant_id: "hotel-one",
      as_of: "2026-10-01",
      role: "manager",
      limit: 25,
      ratio: 0.5,
      include_closed: true,
      level: 2,
    });
  });

  it("starts from an initial value and lets an optional enum be unset again", async () => {
    const { onSubmit, user } = renderHarness({ initialValue: { level: 3, limit: 9 } });

    expect(screen.getByRole("combobox", { name: /^Level/ })).toHaveTextContent("3");
    await user.click(screen.getByRole("combobox", { name: /^Level/ }));
    await user.click(await screen.findByRole("option", { name: "Not set" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ limit: 9 });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("level");
  });

  it("disables every control when asked", () => {
    renderHarness({ disabled: true });

    expect(screen.getByLabelText(/^Tenant/)).toBeDisabled();
    expect(screen.getByRole("switch", { name: /^Include closed/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /^Role/ })).toBeDisabled();
  });
});

describe("SchemaForm validation", () => {
  it("shows no errors before the first submit", () => {
    renderHarness();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks submit and shows Ajv and parse errors next to their fields", async () => {
    const { onSubmit, user } = renderHarness();

    await user.clear(screen.getByLabelText(/^Tenant/));
    await user.type(screen.getByLabelText(/^Tenant/), "ab");
    await user.type(screen.getByLabelText(/^Row limit/), "0");
    await user.type(screen.getByLabelText(/^Ratio/), "abc");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).not.toHaveBeenCalled();
    const tenant = screen.getByLabelText(/^Tenant/);
    expect(tenant).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Use at least 3 characters")).toBeInTheDocument();
    expect(screen.getByText("Must be at least 1")).toBeInTheDocument();
    expect(screen.getByText("Enter a number")).toBeInTheDocument();
    const errorId = tenant.getAttribute("aria-describedby")?.split(" ").at(-1);
    expect(document.getElementById(errorId ?? "")).toHaveTextContent("Use at least 3 characters");
    const field = screen.getByLabelText(/^Tenant/).closest("[data-field]") as HTMLElement;
    expect(within(field).getByRole("alert")).toHaveTextContent("Use at least 3 characters");
  });

  it("reports a required field the user cleared and revalidates live after a submit", async () => {
    const { onSubmit, user } = renderHarness();
    const tenant = screen.getByLabelText(/^Tenant/);

    await user.clear(tenant);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Required")).toBeInTheDocument();

    await user.type(tenant, "abc");
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
    expect(tenant).toHaveAttribute("aria-invalid", "false");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("SchemaForm server error mapping", () => {
  it("shows a 422 detail on its field and the unknown ones in a general list", async () => {
    const { user } = renderHarness();

    await user.click(screen.getByRole("button", { name: "Server rejects" }));

    expect(screen.getByText("String should have at least 3 characters")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Tenant/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("unknown_param: Extra inputs are not permitted")).toBeInTheDocument();
  });

  it("clears the server error of a field once the user edits it", async () => {
    const { user } = renderHarness();
    await user.click(screen.getByRole("button", { name: "Server rejects" }));

    await user.type(screen.getByLabelText(/^Tenant/), "x");

    expect(screen.queryByText("String should have at least 3 characters")).not.toBeInTheDocument();
    expect(screen.getByText("unknown_param: Extra inputs are not permitted")).toBeInTheDocument();
  });

  it("clears every server error on submit", async () => {
    const { user } = renderHarness();
    await user.click(screen.getByRole("button", { name: "Server rejects" }));

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(
      screen.queryByText("unknown_param: Extra inputs are not permitted"),
    ).not.toBeInTheDocument();
  });
});

describe("SchemaForm fallbacks", () => {
  it("shows a raw JSON textarea with a visible notice for a schema outside the subset", () => {
    renderHarness({ schema: RAW_SCHEMA });

    const notice = screen.getByRole("note");
    expect(notice).toHaveTextContent("Edit as JSON");
    expect(notice).toHaveTextContent("The parameter `severities` has a type the form cannot show.");
    expect(notice).toHaveTextContent("The server checks them again.");
    const textbox = screen.getByRole("textbox", { name: "Parameters (JSON)" });
    expect(textbox).toHaveValue("{}");
    expect(textbox).toHaveAttribute("aria-describedby", notice.id);
  });

  it("parses the JSON on submit and reports invalid JSON, non-objects and schema errors", async () => {
    const { onSubmit, user } = renderHarness({ schema: RAW_SCHEMA });
    const textbox = screen.getByRole("textbox", { name: "Parameters (JSON)" });

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("severities: Required")).toBeInTheDocument();

    await user.click(textbox);
    await user.clear(textbox);
    await user.paste("[1]");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Parameters must be a JSON object")).toBeInTheDocument();
    expect(textbox).toHaveAttribute("aria-invalid", "true");

    await user.clear(textbox);
    await user.click(textbox);
    await user.paste('{"severities": ["high"]}');
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ severities: ["high"] });
  });

  it("maps a server 422 onto the JSON textarea", async () => {
    const { user } = renderHarness({ schema: RAW_SCHEMA });

    await user.click(screen.getByRole("button", { name: "Server rejects" }));

    expect(
      screen.getByText("tenant_id: String should have at least 3 characters"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Parameters (JSON)" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("says a schema without properties takes no parameters and submits an empty object", async () => {
    const { onSubmit, user } = renderHarness({ schema: { type: "object", properties: {} } });

    expect(screen.getByText("This takes no parameters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledWith({});
  });
});
