import assert from "node:assert/strict";
import { test } from "node:test";
import { ALIASES_V1 } from "carveout/pseudonyms";

import {
  CARRIED_WORDS_REASON,
  applyAliases,
  carriedWordHazards,
  reverseSubmission,
  type AliasRule,
} from "../src/index.js";

/**
 * A repository file, its version under `rules` (and `rewrite`, the build's
 * own edits beyond the table), a submission carried back by the pinned
 * carry, and the words checked; `check` runs the guard on another carry's
 * output, such as an older carveout's.
 */
function carry(input: {
  rules: AliasRule[];
  path: string;
  repository: string;
  rewrite?: (text: string) => string;
  submit: (version: string) => string;
}) {
  const aliased = applyAliases(
    [{ path: input.path, text: input.repository }],
    input.rules,
  );
  assert.equal(aliased.ok, true, JSON.stringify(aliased.problems));
  const file = aliased.files[0];
  assert.ok(file);
  const version = (input.rewrite ?? ((text) => text))(file.text);
  const submitted = [{ path: file.path, text: input.submit(version) }];
  const common = {
    publicText: (path: string) => (path === file.path ? version : null),
    repositoryText: (path: string) =>
      path === input.path ? input.repository : null,
    rules: input.rules,
    renames: aliased.renames,
  };
  const carried = reverseSubmission({ ...common, submitted, harness: [] });
  assert.deepEqual(carried.refused, []);
  return {
    carried,
    hazards: carriedWordHazards({
      ...common,
      submitted,
      carried: carried.files,
    }),
    check: (files: { path: string; text: string }[]) =>
      carriedWordHazards({ ...common, submitted, carried: files }),
  };
}

test("a host rule's words, learned one by one, would rename a contributor's own `example`: such a carry is withheld", () => {
  const repository =
    "// Docs: https://wiki.orvanta.internal/payments for the team.\nexport const answer = 42;\n";
  const { carried, hazards, check } = carry({
    rules: [
      {
        before: "wiki.orvanta.internal",
        after: "wiki.example.com",
        kind: "text",
        paths: [],
      },
    ],
    path: "src/docs.ts",
    repository,
    submit: (version) => `${version}export const example = 'wiki';\n`,
  });
  // The pinned carry (carveout 0.5.0) keeps the contributor's word.
  assert.equal(
    carried.files[0]?.text,
    `${repository}export const example = 'wiki';\n`,
  );
  assert.deepEqual(hazards, []);
  // carveout 0.3.1's carry put the contributor's word in the client's;
  // the guard still withholds a carry like that.
  assert.deepEqual(
    check([
      {
        path: "src/docs.ts",
        text: `${repository}export const orvanta = 'wiki';\n`,
      },
    ]),
    [{ path: "src/docs.ts", line: 3 }],
  );
  assert.match(CARRIED_WORDS_REASON, /merge-back is withheld/);
});

test("a multi-word brand's word, added alone, carries as written and a carry renaming it is withheld; the brand added whole is the table's, and carries", () => {
  const rules: AliasRule[] = [
    {
      before: "Orvanta Payments",
      after: "Northwind Shop",
      kind: "text",
      paths: [],
    },
    { before: "src/orvanta", after: "src/northwind", kind: "path", paths: [] },
  ];
  const repository = "// Orvanta Payments settles every order.\nexport {};\n";
  const alone = carry({
    rules,
    path: "src/orvanta/pay.ts",
    repository,
    submit: (version) => `${version}export const Shop = "cart";\n`,
  });
  assert.equal(
    alone.carried.files[0]?.text,
    `${repository}export const Shop = "cart";\n`,
  );
  assert.deepEqual(alone.hazards, []);
  // carveout 0.3.1's carry read the word as the brand's; withheld.
  assert.deepEqual(
    alone.check([
      {
        path: "src/orvanta/pay.ts",
        text: `${repository}export const Payments = "cart";\n`,
      },
    ]),
    [{ path: "src/northwind/pay.ts", line: 3 }],
  );
  const whole = carry({
    rules,
    path: "src/orvanta/pay.ts",
    repository,
    submit: (version) => `${version}// Northwind Shop refunds too.\n`,
  });
  assert.equal(
    whole.carried.files[0]?.text,
    `${repository}// Orvanta Payments refunds too.\n`,
  );
  assert.deepEqual(whole.hazards, []);
  // A carry whose lines do not line up with the submission's is not trusted.
  assert.deepEqual(
    alone.check([{ path: "src/orvanta/pay.ts", text: repository }]),
    [{ path: "src/northwind/pay.ts", line: 3 }],
  );
  // A file the carry did not return (unchanged, or refused) is not checked.
  assert.deepEqual(alone.check([]), []);
});

test("what the build renamed beyond the table (an import moved to the slice's mock) carries without a hazard", () => {
  const repository =
    'import { ledger } from "@pay/ledger";\n// Orvanta totals.\nexport const total = () => ledger.sum();\n';
  const { carried, hazards } = carry({
    rules: [{ before: "Orvanta", after: "Northwind", kind: "text", paths: [] }],
    path: "src/fees.ts",
    repository,
    rewrite: (text) =>
      text.replace('"@pay/ledger"', '"../sandbox/mocks/ledger.js"'),
    submit: (version) =>
      `${version}import { ledger as again } from "../sandbox/mocks/ledger.js";\n`,
  });
  assert.equal(
    carried.files[0]?.text,
    `${repository}import { ledger as again } from "@pay/ledger";\n`,
  );
  assert.deepEqual(hazards, []);
});

test("a new file, a moved file and a version built on the old renaming are checked by their repository paths", () => {
  const rules: AliasRule[] = [
    { before: "orvanta", after: "northwind", kind: "path", paths: [] },
  ];
  const base = {
    publicText: () => null,
    repositoryText: () => null,
    rules,
  };
  // A new file: no originals, so the carry is the table's alone.
  assert.deepEqual(
    carriedWordHazards({
      ...base,
      renames: [],
      submitted: [{ path: "src/northwind/new.ts", text: "export {};\n" }],
      carried: [{ path: "src/orvanta/new.ts", text: "export {};\n" }],
    }),
    [],
  );
  // A moved file, under the frozen renaming: a word the table does not
  // rename is a hazard.
  assert.deepEqual(
    carriedWordHazards({
      ...base,
      renames: [{ from: "lib/a.ts", to: "src/a.ts" }],
      aliases: ALIASES_V1,
      submitted: [{ path: "src/a.ts", text: "const a = 1;\n" }],
      carried: [{ path: "lib/a.ts", text: "const b = 1;\n" }],
    }),
    [{ path: "src/a.ts", line: 1 }],
  );
  // Originals whose differing lines do not line up teach nothing.
  assert.deepEqual(
    carriedWordHazards({
      ...base,
      renames: [],
      publicText: () => "f(a)\ng\n",
      repositoryText: () => "f(a, b)\n",
      submitted: [{ path: "x.ts", text: "f(a)\ng\nh(a)\n" }],
      carried: [{ path: "x.ts", text: "f(a, b)\ng\nh(c)\n" }],
    }),
    [{ path: "x.ts", line: 3 }],
  );
});
