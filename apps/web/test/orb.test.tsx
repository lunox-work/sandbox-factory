import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { LoadingLine } from "@/components/Message";
import { ThinkingLine } from "@/components/Thinking";

test("a read waits beside an orb that is not announced", () => {
  render(<LoadingLine>Loading bounties…</LoadingLine>);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading bounties…");
  expect(screen.queryByRole("img")).toBeNull();
  expect(status.querySelector("canvas")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});

test("a model at work says only what it is doing, whatever its orb does", () => {
  render(<ThinkingLine state="searching">Scanning the board</ThinkingLine>);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Scanning the board");
  expect(screen.queryByRole("img")).toBeNull();
  expect(status.querySelector("canvas")?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});
