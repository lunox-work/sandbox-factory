/**
 * Tests for the record opened over the list it came from.
 *
 * The properties that make a peek a peek rather than a styled dialog: it
 * announces itself, it has one scrolling region, and closing it returns the
 * reader to exactly where they were — which is the part Radix does not do on
 * its own here, because the peek has no `Trigger` to return focus to.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";

import { PeekPanel } from "../src/components/PeekPanel";

/** A list whose rows open the peek, as the board page uses it. */
function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Row one
      </button>
      <button type="button">Row two</button>
      <PeekPanel
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        title="Row one"
        description="A record."
        data-testid="peek"
      >
        <p>The record body.</p>
      </PeekPanel>
    </>
  );
}

test("the record opens over the page and names itself", async () => {
  render(<Harness />);

  await userEvent.click(screen.getByRole("button", { name: "Row one" }));

  const dialog = await screen.findByRole("dialog");
  // Named for a screen reader, which announces a dialog by its title — the
  // visible heading belongs to the record inside.
  expect(dialog.getAttribute("aria-labelledby")).not.toBeNull();
  expect(screen.getByText("The record body.")).toBeDefined();
});

test("Escape closes it", async () => {
  const onOpenChange = vi.fn();
  render(<Harness onOpenChange={onOpenChange} />);

  await userEvent.click(screen.getByRole("button", { name: "Row one" }));
  await screen.findByRole("dialog");

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});

test("closing returns focus to the row it was opened from", async () => {
  /*
    The reason this component restores focus itself. Radix returns it to its
    own `Trigger`, and a peek has none — it is opened by a row in a list
    elsewhere in the tree. Without the restore, focus lands on `<body>` and a
    keyboard reader who peeks one record loses their place in the list.
  */
  render(<Harness />);

  const row = screen.getByRole("button", { name: "Row one" });
  await userEvent.click(row);
  await screen.findByRole("dialog");

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(document.activeElement).toBe(row);
  });
});

test("the body scrolls inside the panel, not the page behind it", async () => {
  // One scrolling region while it is open. `overscroll-contain` is what stops
  // reaching the end of the record from scrolling the page underneath.
  render(<Harness />);

  await userEvent.click(screen.getByRole("button", { name: "Row one" }));
  const panel = await screen.findByTestId("peek");

  const scroller = panel.querySelector(".overflow-y-auto");
  expect(scroller).not.toBeNull();
  expect(scroller?.className).toContain("overscroll-contain");
});

test("the close control is reachable and labelled", async () => {
  // Escape and a click outside both work, but neither is discoverable.
  render(<Harness />);

  await userEvent.click(screen.getByRole("button", { name: "Row one" }));
  await screen.findByRole("dialog");

  await userEvent.click(screen.getByRole("button", { name: "Close" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
