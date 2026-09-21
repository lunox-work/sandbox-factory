/**
 * Tests for the identicon contract.
 *
 * The golden vectors are the point of this file. "Same seed, same output"
 * passes for any deterministic function, including a refactored one that has
 * just changed every account's face — only pinned literals catch that, and a
 * changed face cannot be migrated or rolled back. They are never to be
 * regenerated to match a change; a failure here means the change is wrong.
 *
 * The rest are properties rather than values: what the grid must always be
 * (mirrored, never empty), and what the hue must always be (an integer in
 * range). Those hold for any seed, so they are checked over a batch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { identicon } from "../src/identicon.js";

/** Renders a grid as five rows of `#` and `.`, so a diff is readable. */
function art(cells: readonly boolean[]): string {
  return Array.from({ length: 5 }, (_, row) =>
    cells
      .slice(row * 5, row * 5 + 5)
      .map((filled) => (filled ? "#" : "."))
      .join(""),
  ).join("\n");
}

/**
 * Frozen. Computed from this implementation and pinned by hand, covering a
 * bare Better Auth-style id, a prefixed `org_<uuid>`, the degenerate empty
 * seed, and a seed whose bytes are multi-byte — the last of those is what
 * would break if the hash ever stopped reading UTF-8 bytes and started
 * reading UTF-16 code units.
 */
const GOLDEN: ReadonlyArray<{
  readonly seed: string;
  readonly hue: number;
  readonly art: string;
}> = [
  {
    seed: "QZ3kx7mNpR8vWc2LtY6bJdH4sG9aFeUn",
    hue: 105,
    art: ["#...#", ".....", ".###.", ".....", ".#.#."].join("\n"),
  },
  {
    seed: "org_9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
    hue: 187,
    art: [".###.", ".....", ".....", ".....", "##.##"].join("\n"),
  },
  {
    seed: "",
    hue: 225,
    art: ["#.#.#", ".....", "#####", ".###.", "#...#"].join("\n"),
  },
  {
    seed: "Ada Lovelace — éàü 你好",
    hue: 330,
    art: [".#.#.", "#####", "..#..", "..#..", "##.##"].join("\n"),
  },
];

test("the golden vectors are unchanged", () => {
  for (const expected of GOLDEN) {
    const { cells, hue } = identicon(expected.seed);

    assert.equal(
      art(cells),
      expected.art,
      `grid changed for ${JSON.stringify(expected.seed)}`,
    );
    assert.equal(
      hue,
      expected.hue,
      `hue changed for ${JSON.stringify(expected.seed)}`,
    );
  }
});

test("a grid is 25 cells, mirrored across the vertical axis", () => {
  for (let index = 0; index < 1000; index++) {
    const { cells } = identicon(`mirror_${index}`);

    assert.equal(cells.length, 25);

    for (let row = 0; row < 5; row++) {
      const offset = row * 5;
      assert.equal(
        cells[offset],
        cells[offset + 4],
        `row ${row} of mirror_${index} is not mirrored`,
      );
      assert.equal(
        cells[offset + 1],
        cells[offset + 3],
        `row ${row} of mirror_${index} is not mirrored`,
      );
    }
  }
});

test("a hue is an integer in 0-359", () => {
  for (let index = 0; index < 1000; index++) {
    const { hue } = identicon(`hue_${index}`);

    assert.ok(Number.isInteger(hue), `hue_${index} gave a non-integer ${hue}`);
    assert.ok(hue >= 0 && hue <= 359, `hue_${index} gave ${hue}`);
  }
});

/**
 * One hash in 2^15 fills no cell, which would render an empty avatar. This
 * seed is one: found once by search over `seed_<n>`, then pinned.
 *
 * The first assertion is what keeps this test honest. Without it, a change to
 * the hash would leave the seed no longer hitting the all-zero case, and the
 * test would keep passing while covering nothing.
 */
test("a seed that fills no cell still gets the centre", () => {
  const { cells } = identicon("seed_8339");

  assert.deepEqual(
    cells.flatMap((filled, index) => (filled ? [index] : [])),
    [12],
    "seed_8339 no longer reaches the empty-grid guard; find another",
  );
  assert.equal(
    art(cells),
    [".....", ".....", "..#..", ".....", "....."].join("\n"),
  );
});

/**
 * Sequential seeds are the adversarial case for FNV-1a, whose low bits are
 * its weakest and are exactly the bits the cells are drawn from.
 *
 * The space is 2^15 x 360 ~ 11.8M, so among 1000 seeds the expected number of
 * colliding pairs is about 0.04. Asserting 998 leaves room for one collision
 * without permitting a hash that has genuinely stopped spreading.
 */
test("sequential seeds give distinct faces", () => {
  const faces = new Set<string>();

  for (let index = 0; index < 1000; index++) {
    const { cells, hue } = identicon(`user_${index}`);
    faces.add(`${cells.map(Number).join("")}:${hue}`);
  }

  assert.ok(
    faces.size >= 998,
    `only ${faces.size} of 1000 seeds were distinct`,
  );
});

test("ids differing in one character give different faces", () => {
  const base = "org_9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1";
  const faces = new Set<string>();

  for (const last of "0123456789abcdef") {
    const { cells, hue } = identicon(`${base}${last}`);
    faces.add(`${cells.map(Number).join("")}:${hue}`);
  }

  assert.equal(faces.size, 16);
});

test("the same seed gives the same face every time", () => {
  const first = identicon("repeat_me");
  const second = identicon("repeat_me");

  assert.deepEqual(first, second);
});
