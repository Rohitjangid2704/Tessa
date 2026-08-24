import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, fireEvent, screen, userEvent, waitFor } from "@/tests/utils/render";
import { resetLocation, setLocationSilently } from "@/tests/utils/fake-navigation";
import {
  DirtySectionsProvider,
  UnsavedChangesGuard,
  useAnyDirty,
  useReportDirty,
} from "./unsaved-changes";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => router,
}));

let reachedPage: boolean[] = [];

function recordReachedPage(event: MouseEvent): void {
  reachedPage.push(event.defaultPrevented);
  event.preventDefault();
}

beforeEach(() => {
  reachedPage = [];
  resetLocation("/settings");
  document.addEventListener("click", recordReachedPage);
});

afterEach(() => {
  document.removeEventListener("click", recordReachedPage);
  router.push.mockReset();
  resetLocation("/");
});

function Report({ section, dirty }: { section: string; dirty: boolean }) {
  useReportDirty(section, dirty);
  return null;
}

function AnyDirty() {
  return <p>{useAnyDirty() ? "dirty" : "clean"}</p>;
}

const LINKS: ReadonlyArray<{ label: string; href: string; target?: string; download?: boolean }> = [
  { label: "Targets", href: "/targets" },
  { label: "Runs", href: "/runs?target_id=abc" },
  { label: "Same page", href: "/settings#budgets" },
  { label: "External", href: "https://example.com/docs" },
  { label: "New tab", href: "/findings", target: "_blank" },
  { label: "Download", href: "/files/report.csv", download: true },
];

function Harness({ dirty = true }: { dirty?: boolean }) {
  return (
    <DirtySectionsProvider>
      <Report section="budgets" dirty={dirty} />
      <UnsavedChangesGuard />
      <AnyDirty />
      {LINKS.map((link) => (
        <a key={link.label} href={link.href} target={link.target} download={link.download}>
          {link.label}
        </a>
      ))}
    </DirtySectionsProvider>
  );
}

function dispatchBeforeUnload(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("dirty sections", () => {
  it("reports dirty only while a section says so and several sections count together", () => {
    function Two({ first, second }: { first: boolean; second: boolean }) {
      return (
        <DirtySectionsProvider>
          <Report section="a" dirty={first} />
          <Report section="b" dirty={second} />
          <AnyDirty />
        </DirtySectionsProvider>
      );
    }
    const { rerender } = renderWithProviders(<Two first={false} second={false} />);
    expect(screen.getByText("clean")).toBeInTheDocument();

    rerender(<Two first second={false} />);
    expect(screen.getByText("dirty")).toBeInTheDocument();

    rerender(<Two first second />);
    rerender(<Two first={false} second />);
    expect(screen.getByText("dirty")).toBeInTheDocument();

    rerender(<Two first={false} second={false} />);
    expect(screen.getByText("clean")).toBeInTheDocument();
  });

  it("is clean without a provider", () => {
    renderWithProviders(
      <>
        <Report section="a" dirty />
        <AnyDirty />
      </>,
    );

    expect(screen.getByText("clean")).toBeInTheDocument();
  });
});

describe("UnsavedChangesGuard", () => {
  it("does nothing while nothing is unsaved", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness dirty={false} />);

    await user.click(screen.getByRole("link", { name: "Targets" }));

    expect(reachedPage).toEqual([false]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it("warns on unload while something is unsaved", () => {
    renderWithProviders(<Harness />);

    expect(dispatchBeforeUnload()).toBe(true);
  });

  it("intercepts an in-app link click and asks before leaving", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("link", { name: "Targets" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(dialog).toHaveTextContent("Leaving this page discards them");
    expect(reachedPage).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the page when the user chooses to keep editing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("link", { name: "Targets" }));

    await user.click(await screen.findByRole("button", { name: "Keep editing" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.push).not.toHaveBeenCalled();
    expect(dispatchBeforeUnload()).toBe(true);
  });

  it("navigates to the clicked destination, query included, when the user discards", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("link", { name: "Runs" }));

    await user.click(await screen.findByRole("button", { name: "Discard and leave" }));

    expect(router.push).toHaveBeenCalledExactlyOnceWith("/runs?target_id=abc");
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it.each([
    ["a hash link on the same page", "Same page"],
    ["an external link", "External"],
    ["a link that opens a new tab", "New tab"],
    ["a download", "Download"],
  ])("does not intercept %s", async (_name, label) => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("link", { name: label }));

    expect(reachedPage).toEqual([false]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not intercept a modified click or a non-primary button", () => {
    renderWithProviders(<Harness />);
    const link = screen.getByRole("link", { name: "Targets" });

    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { shiftKey: true });
    fireEvent.click(link, { button: 1 });

    expect(reachedPage).toEqual([false, false, false, false]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("stops intercepting once the section is clean again", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(<Harness />);
    rerender(<Harness dirty={false} />);

    await user.click(screen.getByRole("link", { name: "Targets" }));

    expect(reachedPage).toEqual([false]);
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it("treats the same path with another query as leaving", async () => {
    setLocationSilently("/runs?target_id=other");
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(screen.getByRole("link", { name: "Runs" }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });
});
