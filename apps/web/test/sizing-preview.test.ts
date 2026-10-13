import { expect, test } from "vitest";
import type { BountyRunDto } from "@sandbox-factory/shared";

import { previewSize } from "../src/features/bounties/SizingPreview";

/** A drafted spec scoring 5 points: one heavy scenario, one test. XS+. */
const spec = {
  feature: "Invitations",
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "One invitation is sent",
      steps: [{ keyword: "Then", text: "one email" }],
      origin: "draft",
      weight: "heavy",
    },
  ],
  openQuestions: [],
  assumptions: [],
} as const;

const sizing = (complexity: string) => ({
  complexity,
  confidence: "high",
  rationale: "Because.",
});

const running = (progress: Record<string, unknown>) =>
  ({ progress }) as unknown as BountyRunDto;

test("the scenarios size the preview as soon as they land", () => {
  expect(previewSize(undefined)).toBeNull();
  expect(previewSize(running({}))).toBeNull();
  expect(previewSize(running({ spec }))).toBe("XS+");
});

test("the model's size stands only until the scenarios land, or where it is too far from theirs", () => {
  expect(previewSize(running({ sizing: sizing("M") }))).toBe("M");
  // Within two whole sizes: the scenarios' stands, as the server will
  // price it.
  expect(previewSize(running({ spec, sizing: sizing("S+") }))).toBe("XS+");
  // Two whole sizes apart: one of them read the bounty wrong, so the
  // model's is kept for a reviewer, as the server keeps it.
  expect(previewSize(running({ spec, sizing: sizing("M+") }))).toBe("M+");
  // A model that could not size it leaves the scenarios to.
  expect(previewSize(running({ spec, sizing: null }))).toBe("XS+");
  // A draft that failed leaves the model's.
  expect(previewSize(running({ spec: null, sizing: sizing("L") }))).toBe("L");
  expect(previewSize(running({ spec: null, sizing: null }))).toBe("unsized");
});

test("the board's weights score the scenarios", () => {
  // Heavy weighed far more pushes the one scenario up a band.
  expect(
    previewSize(running({ spec }), {
      covered: 0,
      light: 1,
      moderate: 2,
      heavy: 14,
    }),
  ).toBe("M");
});
