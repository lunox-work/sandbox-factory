/**
 * Tests for the question asked before something irreversible.
 *
 * The property: nothing happens until the person says so a second time. The
 * three failure modes worth pinning are the ones that make a confirmation
 * worthless — firing on the trigger alone, firing on cancel, and firing on a
 * typed confirmation that does not match.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Button } from "../src/components/ui/button";

function renderDialog(
  props: Partial<Parameters<typeof ConfirmDialog>[0]> = {},
) {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      trigger={<Button>Delete it</Button>}
      title="Delete it?"
      description="This cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onConfirm };
}

test("opening the dialog does not perform the action", async () => {
  // The whole point: the trigger asks, it does not act.
  const { onConfirm } = renderDialog();

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));

  expect(await screen.findByRole("dialog")).toBeDefined();
  expect(onConfirm).not.toHaveBeenCalled();
});

test("confirming performs it once", async () => {
  const { onConfirm } = renderDialog();

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));

  await waitFor(() => {
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

test("cancelling performs nothing and closes", async () => {
  const { onConfirm } = renderDialog();

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(onConfirm).not.toHaveBeenCalled();
});

test("Escape closes without performing it", async () => {
  const { onConfirm } = renderDialog();

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(onConfirm).not.toHaveBeenCalled();
});

// ---- the typed variant ----------------------------------------------------

test("a typed confirmation stays disabled until the handle matches", async () => {
  const { onConfirm } = renderDialog({ typeToConfirm: "acme" });

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");

  const confirm = screen.getByRole("button", { name: "Delete" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);

  // A near miss is still a miss: this is the guard against muscle memory.
  await userEvent.type(
    screen.getByRole("textbox", { name: /type the handle/i }),
    "acm",
  );
  expect((confirm as HTMLButtonElement).disabled).toBe(true);

  await userEvent.type(
    screen.getByRole("textbox", { name: /type the handle/i }),
    "e",
  );
  await waitFor(() => {
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  await userEvent.click(confirm);
  await waitFor(() => {
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

test("an abandoned draft does not come back on the next open", async () => {
  // Reopening with the handle already typed would turn the second attempt
  // into the single click this exists to prevent.
  renderDialog({ typeToConfirm: "acme" });

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");
  await userEvent.type(
    screen.getByRole("textbox", { name: /type the handle/i }),
    "acme",
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");

  expect(
    (
      screen.getByRole("textbox", {
        name: /type the handle/i,
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(
    (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a write in flight disables both answers", async () => {
  renderDialog({ busy: true });

  await userEvent.click(screen.getByRole("button", { name: "Delete it" }));
  await screen.findByRole("dialog");

  expect(
    (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
