import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCLOSURE_FINDINGS_EVALUATED,
  disclosableDecisions,
  disclosureGate,
  disclosureRecords,
  freezeReadiness,
  gatesOf,
  noChangeRoundTrip,
  openDisclosureFindings,
  PUBLICATION_GATE_CODES,
  scanDisclosure,
  type AliasRule,
  type PublicationGates,
  type VersionSourceRecord,
} from "../src/index.js";

const rule = (
  before: string,
  after: string,
  kind: AliasRule["kind"] = "identifier",
): AliasRule => ({ before, after, kind, paths: [] });

test("decisions reach TASK.md only when neither disclosure scan finds anything in them", () => {
  const vocabulary = ["Orvanta Payments"];
  assert.deepEqual(
    disclosableDecisions(["The Northwind fee rounds up."], vocabulary),
    ["The Northwind fee rounds up."],
  );
  // One left in the workspace's names withholds the whole list.
  assert.deepEqual(
    disclosableDecisions(
      ["The Northwind fee rounds up.", "Orvanta Payments keeps the cent."],
      vocabulary,
    ),
    [],
  );
  // So does a credential.
  assert.deepEqual(
    disclosableDecisions(
      // Joined at runtime, as the other key fixtures are.
      [`Calls carry the key ${["AKIA", "IOSFODNN7EXAMPLF"].join("")}.`],
      vocabulary,
    ),
    [],
  );
  assert.deepEqual(disclosableDecisions([], vocabulary), []);
});

test("the unchanged project carries back to the source, but for the generator's own line edits", () => {
  const repository = [
    'import { charge } from "../ledger/charge";',
    "export function orvantaFee(amount: number) {",
    "  return charge(amount, process.env.ORVANTA_RATE);",
    "}",
    "",
  ].join("\n");
  const project = [
    'import { charge } from "../../mocks/ledger/charge.js";',
    "export function entryFee(amount: number) {",
    "  return charge(amount, process.env.RATE);",
    "}",
    "",
  ].join("\n");
  const source = {
    projectPath: "src/northwind/fees.ts",
    repositoryPath: "src/orvanta/fees.ts",
    publicText: project,
    repositoryText: repository,
  };
  const rules = [rule("orvantaFee", "entryFee")];
  assert.deepEqual(noChangeRoundTrip({ sources: [source], rules }), {
    ok: true,
    files: 1,
    problems: [],
  });
  // Byte for byte when nothing was rewritten.
  assert.equal(
    noChangeRoundTrip({
      sources: [
        {
          ...source,
          publicText: "export const a = 1;\n",
          repositoryText: "export const a = 1;\n",
        },
      ],
      rules: [],
    }).ok,
    true,
  );
  // A line the table does not give back, a file that no longer lines up,
  // and files either side lacks, each named.
  const result = noChangeRoundTrip({
    sources: [
      {
        ...source,
        projectPath: "src/a.ts",
        publicText: project.replace("entryFee", "otherFee"),
      },
      {
        ...source,
        projectPath: "src/b.ts",
        publicText: `// added\n${project}`,
      },
      { ...source, projectPath: "src/c.ts", repositoryText: null },
      { ...source, projectPath: "src/d.ts", publicText: null },
    ],
    rules,
  });
  assert.equal(result.ok, false);
  assert.equal(result.files, 4);
  assert.deepEqual(
    result.problems.map((problem) => [problem.path, problem.reason]),
    [
      [
        "src/a.ts",
        "Line 2, read back through the name table, is not the repository's line.",
      ],
      [
        "src/b.ts",
        "It has 5 lines and the repository's 4, so a change to it cannot be carried back.",
      ],
      [
        "src/c.ts",
        "The repository has no src/orvanta/fees.ts at the pinned commit.",
      ],
      ["src/d.ts", "The project does not have this copied file."],
    ],
  );
  // An identifier differing off a `process.env` line is not the generator's.
  assert.equal(
    noChangeRoundTrip({
      sources: [
        {
          ...source,
          publicText: "export const total = 1;\n",
          repositoryText: "export const sum = 1;\n",
        },
      ],
      rules: [],
    }).ok,
    false,
  );
});

const gates: PublicationGates = {
  roundTrip: { status: "passed", files: 2, problems: [] },
  disclosure: { status: "passed", scannedBy: "build", names: 3, blocking: 0 },
};
const manifest = {
  manifestSha256: "m".repeat(64),
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  baseline: { ok: true } as never,
};
const source = {
  manifestSha256: "m".repeat(64),
  transformConfigSha256: "t".repeat(64),
  approvedTaskSha256: "a".repeat(64),
  harnessSha256: "h".repeat(64),
  toolchainDigest: "d".repeat(64),
  buildRunId: "arn_build",
  approvedBy: "user_1",
  approvedAt: "2026-11-15T00:00:00.000Z",
} as VersionSourceRecord;

test("a build's gates read as freeze evidence: the build run proves both, or names the gate that failed", () => {
  const passed = gatesOf("arn_build", { ...manifest, gates });
  assert.deepEqual(
    [passed.recorded, passed.roundTripRunId, passed.disclosureRunId],
    [true, "arn_build", "arn_build"],
  );
  assert.deepEqual(
    freezeReadiness(
      {
        ...source,
        roundTripRunId: passed.roundTripRunId,
        disclosureRunId: passed.disclosureRunId,
      },
      passed.evidence,
    ).failed,
    [],
  );
  // Nothing to carry back to passes; a failed round trip does not.
  assert.equal(
    gatesOf("arn_build", {
      ...manifest,
      gates: {
        ...gates,
        roundTrip: { status: "not_applicable", files: 0, problems: [] },
      },
    }).roundTripRunId,
    "arn_build",
  );
  const failed = gatesOf("arn_build", {
    ...manifest,
    gates: {
      roundTrip: { status: "failed", files: 2, problems: [] },
      disclosure: {
        status: "failed",
        scannedBy: "build",
        names: 3,
        blocking: 2,
      },
    },
  });
  const check = freezeReadiness(
    {
      ...source,
      roundTripRunId: failed.roundTripRunId,
      disclosureRunId: failed.disclosureRunId,
    },
    failed.evidence,
  );
  assert.deepEqual(check.failed, ["round_trip", "disclosure"]);
  assert.equal(PUBLICATION_GATE_CODES.round_trip, "round_trip_failed");
  assert.equal(PUBLICATION_GATE_CODES.disclosure, "disclosure_failed");
  // A build made before the gates recorded none.
  const old = gatesOf("arn_build", manifest);
  assert.deepEqual(
    [
      old.recorded,
      old.roundTripRunId,
      old.disclosureRunId,
      old.evidence.disclosureBlocking,
    ],
    [false, null, null, null],
  );
});

test("the disclosure gate counts the scans' blockers alone", () => {
  assert.deepEqual(
    disclosureGate(
      [
        { code: "vocabulary_leaked", file: "README.md", detail: "x" },
        { code: "secret_found", file: "a.ts", detail: "y" },
        { code: "baseline_failed", file: null, detail: "z" },
      ],
      4,
    ),
    { status: "failed", scannedBy: "build", names: 4, blocking: 2 },
  );
  assert.deepEqual(disclosureGate([], 0, "upload"), {
    status: "passed",
    scannedBy: "upload",
    names: 0,
    blocking: 0,
  });
});

test("an upload's or starter's findings wait for publication: the build stays ready, the draft's list settles the gate", () => {
  const found = scanDisclosure([
    {
      path: "src/app.ts",
      text: "// See https://docs.stripe.com/api and mail jo@acme.io\n",
    },
  ]);
  assert.equal(found.length, 2);
  const pending = disclosureGate([], 0, "upload", {
    findings: disclosureRecords(found, [], DISCLOSURE_FINDINGS_EVALUATED),
    total: found.length,
    unacknowledged: found.length,
    acknowledgedAt: "publish",
  });
  // Not a blocker: the build read no acknowledgement.
  assert.equal(pending.status, "pending_acknowledgement");
  assert.equal(pending.blocking, 0);
  assert.equal(pending.acknowledgedAt, "publish");
  assert.equal(pending.acknowledged, 0);
  assert.deepEqual(
    pending.findings?.map(({ kind, value, acknowledged }) => [
      kind,
      value,
      acknowledged,
    ]),
    [
      ["email", "jo@acme.io", false],
      ["url", "https://docs.stripe.com/api", false],
    ],
  );
  const read = (
    acknowledgements: { kind: "host" | "email"; value: string }[],
  ) => {
    const gated = gatesOf(
      "arn_build",
      {
        ...manifest,
        gates: {
          roundTrip: { status: "not_applicable", files: 0, problems: [] },
          disclosure: pending,
        },
      },
      acknowledgements,
    );
    return freezeReadiness(
      {
        ...source,
        roundTripRunId: gated.roundTripRunId,
        disclosureRunId: gated.disclosureRunId,
      },
      gated.evidence,
    ).failed;
  };
  assert.deepEqual(read([]), ["disclosure"]);
  // A host covers the link on it; the address still holds it.
  assert.deepEqual(read([{ kind: "host", value: "stripe.com" }]), [
    "disclosure",
  ]);
  assert.deepEqual(
    openDisclosureFindings(pending, [
      { kind: "host", value: "stripe.com" },
    ]).findings.map((finding) => finding.value),
    ["jo@acme.io"],
  );
  assert.deepEqual(
    read([
      { kind: "host", value: "stripe.com" },
      { kind: "email", value: "jo@acme.io" },
    ]),
    [],
  );
  // Findings past the record cannot be acknowledged: they hold it.
  const overflowing = { ...pending, total: found.length + 3 };
  assert.deepEqual(
    openDisclosureFindings(overflowing, [
      { kind: "host", value: "stripe.com" },
      { kind: "email", value: "jo@acme.io" },
    ]),
    { findings: [], unrecorded: 3 },
  );
  const held = gatesOf(
    "arn_build",
    {
      ...manifest,
      gates: {
        roundTrip: { status: "not_applicable", files: 0, problems: [] },
        disclosure: overflowing,
      },
    },
    [
      { kind: "host", value: "stripe.com" },
      { kind: "email", value: "jo@acme.io" },
    ],
  );
  assert.equal(held.evidence.disclosureBlocking, 3);
  // The refusal names findings that wait for an acknowledgement, not
  // blocking findings: two open on the record, then three past it.
  const reasonsOf = (gated: ReturnType<typeof gatesOf>) =>
    freezeReadiness(
      {
        ...source,
        roundTripRunId: gated.roundTripRunId,
        disclosureRunId: gated.disclosureRunId,
      },
      gated.evidence,
    ).reasons;
  const unacknowledged = gatesOf("arn_build", {
    ...manifest,
    gates: {
      roundTrip: { status: "not_applicable", files: 0, problems: [] },
      disclosure: pending,
    },
  });
  assert.equal(unacknowledged.evidence.disclosureAwaiting, 2);
  assert.deepEqual(reasonsOf(unacknowledged), [
    "2 findings wait for an owner's acknowledgement.",
  ]);
  assert.deepEqual(reasonsOf(held), [
    "3 findings wait for an owner's acknowledgement.",
  ]);
  const one = gatesOf(
    "arn_build",
    {
      ...manifest,
      gates: {
        roundTrip: { status: "not_applicable", files: 0, problems: [] },
        disclosure: pending,
      },
    },
    [{ kind: "host", value: "stripe.com" }],
  );
  assert.deepEqual(reasonsOf(one), [
    "1 finding waits for an owner's acknowledgement.",
  ]);
  // Names or credentials fail the gate whatever is acknowledged.
  const leaked = disclosureGate(
    [{ code: "secret_found", file: "a.ts", detail: "" }],
    0,
    "upload",
    {
      findings: disclosureRecords(found, []),
      total: found.length,
      unacknowledged: found.length,
      acknowledgedAt: "publish",
    },
  );
  assert.equal(leaked.status, "failed");
  assert.equal(leaked.blocking, 1);
  const leakedGates = gatesOf("arn_build", {
    ...manifest,
    gates: {
      roundTrip: { status: "not_applicable", files: 0, problems: [] },
      disclosure: leaked,
    },
  });
  assert.equal(leakedGates.evidence.disclosureAwaiting, undefined);
  assert.deepEqual(reasonsOf(leakedGates), [
    "The disclosure scan has blocking findings.",
  ]);
  // Nothing found passes outright; a sliced build's gate reads its marks.
  assert.equal(
    disclosureGate([], 0, "upload", {
      findings: [],
      total: 0,
      unacknowledged: 0,
      acknowledgedAt: "publish",
    }).status,
    "passed",
  );
  const sliced = disclosureGate([], 2, "build", {
    findings: disclosureRecords(found, [
      { kind: "email", value: "jo@acme.io" },
    ]),
    total: 2,
    unacknowledged: 1,
  });
  assert.equal(sliced.acknowledgedAt, undefined);
  assert.deepEqual(
    openDisclosureFindings(sliced, [{ kind: "host", value: "stripe.com" }]),
    { findings: [sliced.findings?.[1]], unrecorded: 0 },
  );
});
