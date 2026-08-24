import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { TokenOnce } from "./token-once";

const SECRET = `ipt_${"AbCdEfGhIj".repeat(4)}XyZ`;

function renderOnce(onDone = vi.fn()) {
  const view = renderWithProviders(
    <Dialog open>
      <DialogContent>
        <TokenOnce tokenName="laptop" token={SECRET} onDone={onDone} />
      </DialogContent>
    </Dialog>,
  );
  return { ...view, onDone };
}

describe("TokenOnce", () => {
  it("shows the token in a read-only field with the warning that it is shown once", () => {
    renderOnce();
    expect(screen.getByLabelText("Personal token")).toHaveValue(SECRET);
    expect(screen.getByLabelText("Personal token")).toHaveAttribute("readonly");
    expect(screen.getByText("This token is shown once")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
  });

  it("copies the token to the clipboard", async () => {
    const user = userEvent.setup();
    renderOnce();
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByText("Copied to clipboard")).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(SECRET);
  });

  it("calls onDone from the I copied it button", async () => {
    const user = userEvent.setup();
    const { onDone } = renderOnce();
    await user.click(screen.getByRole("button", { name: "I copied it" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("leaves nothing in the DOM once unmounted", () => {
    const { unmount } = renderOnce();
    unmount();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });
});
