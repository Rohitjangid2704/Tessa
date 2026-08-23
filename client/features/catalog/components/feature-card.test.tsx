import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildCatalogItem } from "@/mocks/factories/catalog";
import { FeatureCard } from "./feature-card";

function card() {
  return screen.getByRole("article");
}

async function openDetails(name: RegExp = /^Details/) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name }));
  return user;
}

const READ_ITEM = buildCatalogItem({
  feature_id: "smart_log.read.open_maintenance",
  area: "Smart Log",
  kind: "read",
  description: "List maintenance issues that are still open",
  interface_ids: ["chat_sse", "browser"],
  roles: ["all"],
  flag: "none",
  preconditions: ["seed.smart_log_history"],
  examples: [
    {
      ask: "Which maintenance issues are still open?",
      expected: "count of open items from the oracle",
      oracle: "open_maintenance",
    },
  ],
  invariants: ["no_internal_ids", "count_consistency"],
  cleanup: "none",
  confidence: "high",
});

const WRITE_ITEM = buildCatalogItem({
  feature_id: "guest_requests.write.create_service_request",
  area: "Guest Requests",
  kind: "write",
  description: "Create a service request after confirmation",
  interface_ids: ["chat_sse", "rest_api"],
  roles: ["guest", "front_desk"],
  flag: "GUEST_REQUESTS_WRITE_ENABLED",
  preconditions: ["seed.guest_requests", "role.guest.logged_in"],
  examples: [
    { ask: "I need two extra towels", expected: "Gracie waits for the confirmation click" },
    {
      request: { method: "POST", path: "/guest-requests", body: { room: "20003" } },
      expected: "201 with the new request id",
      oracle: "guest_request_by_id",
    },
  ],
  invariants: ["idempotent_writes"],
  cleanup: "Delete the created request by id",
  confidence: "medium",
  writes_to: "guest_requests",
  confirmation: "Confirm button in the chat",
  expect_db: { table: "guest_requests", expect: { status: "open" } },
});

describe("FeatureCard header", () => {
  it("names the card after the feature id and shows kind, confidence and description", () => {
    render(<FeatureCard item={READ_ITEM} />);

    expect(
      screen.getByRole("article", { name: "smart_log.read.open_maintenance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "smart_log.read.open_maintenance" }),
    ).toBeInTheDocument();
    expect(within(card()).getByText("Read")).toHaveAttribute("data-slot", "status-badge");
    expect(within(card()).getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("List maintenance issues that are still open")).toBeInTheDocument();
    expect(card()).toHaveAttribute("data-item-id", READ_ITEM.id);
  });

  it("lists interface chips and spells out the all-roles marker", () => {
    render(<FeatureCard item={READ_ITEM} />);

    const interfaces = screen.getByRole("list", { name: "Interfaces" });
    expect(
      within(interfaces)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["chat_sse", "browser"]);
    const roles = screen.getByRole("list", { name: "Roles" });
    expect(
      within(roles)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["All roles"]);
  });

  it("shows named roles as they are", () => {
    render(<FeatureCard item={WRITE_ITEM} />);

    const roles = screen.getByRole("list", { name: "Roles" });
    expect(
      within(roles)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["guest", "front_desk"]);
  });

  it("shows a feature flag and hides the flag row when there is none", () => {
    const { rerender } = render(<FeatureCard item={WRITE_ITEM} />);
    expect(screen.getByRole("list", { name: "Flag" })).toHaveTextContent(
      "GUEST_REQUESTS_WRITE_ENABLED",
    );

    rerender(<FeatureCard item={READ_ITEM} />);
    expect(screen.queryByRole("list", { name: "Flag" })).not.toBeInTheDocument();
  });

  it("makes a write feature stand out from a read feature", () => {
    const { rerender } = render(<FeatureCard item={WRITE_ITEM} />);
    expect(within(card()).getByText("Write").closest("[data-slot=status-badge]")).toHaveAttribute(
      "data-tone",
      "severity-medium",
    );

    rerender(<FeatureCard item={READ_ITEM} />);
    expect(within(card()).getByText("Read").closest("[data-slot=status-badge]")).toHaveAttribute(
      "data-tone",
      "hollow",
    );
  });

  it.each([
    ["high", "High confidence", "verdict-pass"],
    ["medium", "Medium confidence", "verdict-flaky"],
    ["low", "Low confidence", "verdict-uncertain"],
  ] as const)("shows %s confidence as text and tone", (confidence, label, tone) => {
    render(<FeatureCard item={buildCatalogItem({ confidence })} />);

    expect(screen.getByText(label).closest("[data-slot=status-badge]")).toHaveAttribute(
      "data-tone",
      tone,
    );
  });
});

describe("FeatureCard details", () => {
  it("keeps the details closed until asked and reports the example count", async () => {
    render(<FeatureCard item={WRITE_ITEM} />);

    const toggle = screen.getByRole("button", {
      name: /Details of guest_requests\.write\.create_service_request/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("2 examples");
    expect(screen.queryByRole("heading", { name: "Preconditions" })).not.toBeInTheDocument();

    await openDetails();

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { level: 4, name: "Preconditions" })).toBeInTheDocument();
  });

  it("shows preconditions, ask and oracle examples, invariants and an empty cleanup", async () => {
    render(<FeatureCard item={READ_ITEM} />);
    await openDetails();

    const preconditions = screen.getByRole("region", { name: "Preconditions" });
    expect(within(preconditions).getByText("seed.smart_log_history")).toBeInTheDocument();
    const examples = screen.getByRole("region", { name: "Examples (1)" });
    expect(within(examples).getByText("Which maintenance issues are still open?")).toBeVisible();
    expect(within(examples).getByText("count of open items from the oracle")).toBeVisible();
    expect(within(examples).getByText("open_maintenance")).toBeVisible();
    const invariants = screen.getByRole("list", { name: "Invariants" });
    expect(within(invariants).getAllByRole("listitem")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Cleanup" })).getByText("None")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Write details" })).not.toBeInTheDocument();
  });

  it("renders a request example as formatted JSON next to the expectation", async () => {
    render(<FeatureCard item={WRITE_ITEM} />);
    await openDetails();

    const examples = screen.getByRole("region", { name: "Examples (2)" });
    const second = within(examples).getAllByRole("listitem")[1];
    expect(second).toBeDefined();
    expect(within(second as HTMLElement).getByText("Request")).toBeInTheDocument();
    expect(second?.querySelector("pre")?.textContent).toBe(
      JSON.stringify({ method: "POST", path: "/guest-requests", body: { room: "20003" } }, null, 2),
    );
    expect(within(second as HTMLElement).getByText("201 with the new request id")).toBeVisible();
    expect(within(second as HTMLElement).getByText("guest_request_by_id")).toBeVisible();
  });

  it("shows where a write goes, how it is confirmed and the expected database state", async () => {
    render(<FeatureCard item={WRITE_ITEM} />);
    await openDetails();

    const details = screen.getByRole("region", { name: "Write details" });
    expect(within(details).getByText("Writes to").nextElementSibling).toHaveTextContent(
      "guest_requests",
    );
    expect(within(details).getByText("Confirmation").nextElementSibling).toHaveTextContent(
      "Confirm button in the chat",
    );
    expect(details.querySelector("pre")?.textContent).toBe(
      JSON.stringify(WRITE_ITEM.expect_db, null, 2),
    );
    expect(
      within(screen.getByRole("region", { name: "Cleanup" })).getByText(
        "Delete the created request by id",
      ),
    ).toBeVisible();
  });

  it("skips the rows of a write that omits optional details", async () => {
    render(
      <FeatureCard
        item={buildCatalogItem({ kind: "write", writes_to: "orders", confirmation: null })}
      />,
    );
    await openDetails();

    const details = screen.getByRole("region", { name: "Write details" });
    expect(within(details).getByText("Writes to")).toBeInTheDocument();
    expect(within(details).queryByText("Confirmation")).not.toBeInTheDocument();
    expect(within(details).queryByText("Expected database state")).not.toBeInTheDocument();
  });

  it("says so when a feature has no examples, preconditions or invariants", async () => {
    render(
      <FeatureCard item={buildCatalogItem({ examples: [], preconditions: [], invariants: [] })} />,
    );
    const toggle = screen.getByRole("button", { name: /^Details/ });
    expect(toggle).toHaveTextContent("0 examples");
    await openDetails();

    expect(screen.getByText("No examples in this bundle.")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Preconditions" })).getByText("None"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Invariants" })).getByText("None"),
    ).toBeInTheDocument();
  });

  it("opens by default when asked to", () => {
    render(<FeatureCard item={READ_ITEM} defaultOpen />);

    expect(screen.getByRole("region", { name: "Examples (1)" })).toBeVisible();
  });

  it("opens and closes from the keyboard", async () => {
    const user = userEvent.setup();
    render(<FeatureCard item={READ_ITEM} />);
    const toggle = screen.getByRole("button", { name: /^Details/ });

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "Examples (1)" })).toBeVisible();
    await user.keyboard(" ");
    expect(screen.queryByRole("region", { name: "Examples (1)" })).not.toBeInTheDocument();
  });
});

describe("FeatureCard selection", () => {
  it("has no checkbox while it is read-only", () => {
    render(<FeatureCard item={READ_ITEM} />);

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows a labelled checkbox that reports changes once selection is wired", async () => {
    const onSelectedChange = vi.fn();
    const user = userEvent.setup();
    render(<FeatureCard item={READ_ITEM} selected={false} onSelectedChange={onSelectedChange} />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Select smart_log.read.open_maintenance",
    });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });

  it("reflects a selected card", () => {
    render(<FeatureCard item={READ_ITEM} selected onSelectedChange={() => undefined} />);

    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});

describe("FeatureCard proposal risk", () => {
  it.each([
    ["high", "High risk", "severity-high"],
    ["medium", "Medium risk", "severity-medium"],
    ["low", "Low risk", "severity-low"],
  ] as const)("shows a %s proposal risk next to the confidence chip", (risk, label, tone) => {
    render(<FeatureCard item={buildCatalogItem({ proposal_risk: risk })} />);

    const chip = screen.getByText(label).closest("[data-slot=proposal-risk-chip]");
    expect(chip).toHaveAttribute("data-tone", tone);
    expect(chip).toHaveAttribute("title", "Risk from the test proposal");
    expect(chip?.previousElementSibling).toHaveTextContent("confidence");
  });

  it("shows no risk chip without a proposal risk", () => {
    const { rerender } = render(<FeatureCard item={buildCatalogItem()} />);
    expect(card().querySelector("[data-slot=proposal-risk-chip]")).toBeNull();

    rerender(<FeatureCard item={buildCatalogItem({ proposal_risk: null })} />);
    expect(card().querySelector("[data-slot=proposal-risk-chip]")).toBeNull();
  });
});
