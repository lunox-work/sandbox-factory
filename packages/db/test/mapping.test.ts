import assert from "node:assert/strict";
import { test } from "node:test";

import { generateId, ID_PREFIXES } from "../src/mapping.js";

test("generateId returns unique prefixed ids", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateId("jrc")));
  assert.equal(ids.size, 100);
  for (const id of ids) {
    assert.match(id, /^jrc_/);
  }
});

test("generateId takes the prefix of the table it is for", () => {
  // An id that leaks into a log or a URL says what it is, and a board id
  // passed where an issue id belongs is visible rather than a silent 404.
  assert.match(generateId("jrb"), /^jrb_/);
  assert.match(generateId("bpr"), /^bpr_/);
});

test("every declared prefix produces a distinct, well-formed id", () => {
  const ids = ID_PREFIXES.map((prefix) => generateId(prefix));

  assert.equal(new Set(ids).size, ID_PREFIXES.length);
  for (const [index, id] of ids.entries()) {
    // `<prefix>_<uuid>`, and the uuid half is what makes it unique.
    assert.match(id, new RegExp(`^${ID_PREFIXES[index]}_[0-9a-f-]{36}$`));
  }
});
