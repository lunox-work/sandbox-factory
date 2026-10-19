import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpecDraft } from "sandbox-factory";
import {
  SCOPE_CANDIDATES_MAX,
  scopeCandidates,
  scopeCandidatesSection,
} from "../src/agent/scope-candidates.js";

const spec = (feature: string, ...steps: string[]): SpecDraft => ({
  feature,
  background: [],
  scenarios: [
    {
      id: "s1",
      kind: "happy",
      title: "Invoices are retried",
      steps: steps.map((text) => ({ keyword: "When" as const, text })),
      origin: "draft",
    },
  ],
  openQuestions: [],
  assumptions: [],
});
const module = (path: string, exports: string[] = [], importers = 0) => ({
  path,
  exports: exports.map((name) => ({ name })),
  importers,
});

test("modules rank by the spec's rarer words, in their path above their exports", () => {
  const candidates = scopeCandidates({
    spec: spec("Retry failed invoice payments", "the payment gateway fails"),
    modules: [
      module("src/billing/invoice-retry.ts", ["retryInvoice"]),
      module("src/billing/gateway.ts", ["chargePayment"], 3),
      module("src/billing/ledger.ts", ["postEntry"]),
      // A word every module has says little; a barrel only gathers others.
      module("src/billing/index.ts", ["retryInvoice", "chargePayment"]),
      // A surface this wide matches anything by its exports.
      module(
        "src/everything.ts",
        Array.from({ length: 41 }, (_, index) => `invoice${index}`),
      ),
    ],
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ["src/billing/invoice-retry.ts", "src/billing/gateway.ts"],
  );
  // Plurals and singulars are one word; Gherkin's own words are none.
  // Words of equal weight in alphabetical order.
  assert.deepEqual(candidates[0]?.matched, ["invoice", "retry"]);
  assert.deepEqual(candidates[1]?.matched, ["gateway", "payment"]);
});

test("the ranking is capped, and a spec with no words, or nothing matching, finds none", () => {
  const many = [
    ...Array.from({ length: SCOPE_CANDIDATES_MAX + 5 }, (_, index) =>
      module(`src/invoice/part${index}.ts`, [], index),
    ),
    // Without these, every module would carry the word, and it would say
    // nothing.
    module("src/ledger/post.ts"),
    module("src/ledger/close.ts"),
  ];
  const ranked = scopeCandidates({
    spec: spec("Invoice parts"),
    modules: many,
  });
  assert.equal(ranked.length, SCOPE_CANDIDATES_MAX);
  // Ties go to the more imported.
  assert.equal(
    ranked[0]?.path,
    `src/invoice/part${SCOPE_CANDIDATES_MAX + 4}.ts`,
  );
  assert.deepEqual(
    scopeCandidates({
      spec: { ...spec("When then and"), scenarios: [] },
      modules: many,
    }),
    [],
  );
  assert.equal(scopeCandidatesSection([]), null);
});

test("the section names each candidate's shared words and first exports", () => {
  const text = scopeCandidatesSection([
    {
      path: "src/billing/gateway.ts",
      matched: ["gateway", "payment"],
      exports: Array.from({ length: 10 }, (_, index) => `e${index}`),
      importers: 3,
    },
    {
      path: "src/billing/notes.ts",
      matched: ["invoice"],
      exports: [],
      importers: 0,
    },
  ]);
  assert.match(
    text ?? "",
    /- src\/billing\/gateway\.ts \(imported by 3\): shares gateway, payment; exports e0, e1, e2, e3, e4, e5, e6, e7, and 2 more/,
  );
  assert.match(
    text ?? "",
    /- src\/billing\/notes\.ts \(imported by 0\): shares invoice$/m,
  );
});
