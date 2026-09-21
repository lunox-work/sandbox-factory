/**
 * A default avatar computed from an account id.
 *
 * Every user and every organization has a face without anyone uploading one
 * and without us storing a byte: the grid and the colour are a pure function
 * of the id, so the only "storage" is the id that already exists.
 *
 * Lives here rather than in the web app because it is a contract, not a
 * component. A route that serves an identicon as an image — for an email,
 * where inline SVG cannot go — would call this same function and get the same
 * face.
 *
 * **The algorithm below is frozen.** It is not an implementation detail: it
 * decides what every existing account looks like. Changing the hash, the bit
 * assignment, the mirror, or the hue derivation changes every face in the
 * product, with no migration possible and nothing to roll back to. The golden
 * vectors in `test/identicon.test.ts` are there to make that impossible to do
 * by accident, and they are never to be regenerated to match a change.
 *
 * Tuning the *look* is still cheap, because nothing here decides it: the
 * lightness and chroma the hue is rendered at are CSS tokens in
 * `apps/web/src/index.css`, not values in this file.
 */

/** Cells per side. */
const SIZE = 5;

/**
 * Columns drawn from the hash. The remaining two mirror these, which is what
 * makes the result read as a deliberate mark rather than as noise — it is the
 * single most important visual decision here.
 */
const DRAWN_COLUMNS = 3;

/** Cells the hash decides directly: 3 columns x 5 rows. */
const DRAWN_CELLS = DRAWN_COLUMNS * SIZE;

/** Index of the centre cell, forced on when the hash fills nothing. */
const CENTRE = Math.floor((SIZE * SIZE) / 2);

/** FNV-1a, 32-bit. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export interface Identicon {
  /**
   * 25 cells, row-major, mirrored across the vertical axis. `true` is a filled
   * cell.
   */
  readonly cells: readonly boolean[];
  /** Degrees, 0-359. What lightness and chroma it is drawn at is the caller's. */
  readonly hue: number;
}

/**
 * FNV-1a over the UTF-8 bytes of `seed`, as an unsigned 32-bit integer.
 *
 * Deliberately not a cryptographic hash. The seed is an id already visible to
 * anyone who can see the avatar, so there is nothing to protect, and
 * `crypto.subtle.digest` returns a promise in the browser, which would make
 * every avatar async for no gain.
 *
 * FNV-1a's low bits are its weakest and the cells are drawn from them, so
 * that was measured rather than assumed: over 8,000 pairs of ids differing
 * only in their last character, 7.26 of the 15 cell bits flip on average
 * against an ideal of 7.5, and no pair collided. Adding murmur3's `fmix32`
 * finalizer moved that to 7.49 and changed nothing else — not worth five more
 * lines in a function whose output can never change.
 *
 * `Math.imul` rather than `*`: the product overflows 53 bits, so plain
 * multiplication would silently lose the low bits that the next byte mixes
 * into.
 */
function hash(seed: string): number {
  let h = FNV_OFFSET_BASIS;

  for (const byte of new TextEncoder().encode(seed)) {
    h ^= byte;
    h = Math.imul(h, FNV_PRIME);
  }

  return h >>> 0;
}

/**
 * The identicon for an account id.
 *
 * `seed` is the id and never the name, the handle, or the email: a face must
 * not change when someone renames themselves. Any string is accepted,
 * including the empty one — a seedless avatar is not this function's problem
 * to diagnose, and it still returns a mark rather than throwing.
 */
export function identicon(seed: string): Identicon {
  const h = hash(seed);

  // Bit `r * 3 + c` decides row r, column c. The mirror means column 3 reads
  // column 1 and column 4 reads column 0.
  const cells = Array.from({ length: SIZE * SIZE }, (_, index) => {
    const row = Math.floor(index / SIZE);
    const column = index % SIZE;
    const drawn = column < DRAWN_COLUMNS ? column : SIZE - 1 - column;

    return (h & (1 << (row * DRAWN_COLUMNS + drawn))) !== 0;
  });

  // One hash in 2^15 fills nothing, which would render an empty avatar. Rare,
  // but reachable, and `test/identicon.test.ts` pins a seed that reaches it.
  if (!cells.includes(true)) {
    cells[CENTRE] = true;
  }

  return {
    cells,
    // The bits the cells did not spend. `>>>` rather than `>>`: the sign bit
    // is one of them, and an arithmetic shift would make the hue negative for
    // every seed whose hash has it set.
    hue: (h >>> DRAWN_CELLS) % 360,
  };
}
