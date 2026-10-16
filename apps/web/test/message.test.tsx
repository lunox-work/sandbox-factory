/**
 * Tests for the two shared message components.
 *
 * What these pin is the part a page depends on and cannot see for itself: the
 * ARIA role each one carries, and that `FormStatus` distinguishes a refusal
 * from a success. The exact spacing and colour classes are not asserted —
 * those are the styling these were extracted to keep in one place, and a test
 * repeating them would only have to be rewritten alongside it.
 */

import { render, screen } from "./render";
import { expect, test } from "vitest";

import {
  ErrorBanner,
  FormStatus,
  LoadingLine,
} from "../src/components/Message";

test("an error banner announces itself as an alert", () => {
  render(<ErrorBanner>Could not load workspaces.</ErrorBanner>);

  expect(screen.getByRole("alert").textContent).toBe(
    "Could not load workspaces.",
  );
});

test("a form status announces itself politely, not as an alert", () => {
  render(<FormStatus failed={false}>Saved.</FormStatus>);

  expect(screen.getByRole("status").textContent).toBe("Saved.");
  expect(screen.queryByRole("alert")).toBeNull();
});

/*
 * The two states share a line, so the only thing telling them apart is the
 * colour. Asserting the one class that carries the meaning — a refused save
 * that reads as an ordinary one would be the failure worth catching.
 */
test("a failed form status is coloured as a failure", () => {
  const { rerender } = render(
    <FormStatus failed={false}>That handle is taken.</FormStatus>,
  );

  expect(screen.getByRole("status").className).not.toContain(
    "text-destructive",
  );

  rerender(<FormStatus failed={true}>That handle is taken.</FormStatus>);

  expect(screen.getByRole("status").className).toContain("text-destructive");
});

test("a loading line is there at once, and shown only once a read is slow", () => {
  render(<LoadingLine>Listing its files…</LoadingLine>);
  const line = screen.getByRole("status");
  // In the document from the start, so a screen reader is told; held
  // invisible for 150ms by its animation, so an instant read never flashes.
  expect(line.textContent).toBe("Listing its files…");
  expect(line.classList.contains("loading-line-in")).toBe(true);
});
