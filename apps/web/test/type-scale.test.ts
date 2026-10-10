import { expect, test } from "vitest";

import { cn } from "../src/lib/utils";

// The type scale's steps are font sizes to `cn`, not colours: unregistered,
// tailwind-merge took `text-title` for a colour and dropped it beside one.

test("a type role survives a text colour beside it", () => {
  expect(cn("text-title", "text-muted-foreground")).toBe(
    "text-title text-muted-foreground",
  );
  expect(cn("text-2xs text-foreground")).toBe("text-2xs text-foreground");
});

test("a type role and a size replace each other, last one winning", () => {
  expect(cn("text-sm", "text-heading")).toBe("text-heading");
  expect(cn("text-subheading", "text-xs")).toBe("text-xs");
  expect(cn("text-display", "text-2xs")).toBe("text-2xs");
});
