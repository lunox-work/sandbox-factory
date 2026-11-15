import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acknowledges,
  applyAliases,
  carryHazards,
  commentAndStringRanges,
  disclosureBlockers,
  disclosureGate,
  disclosureHints,
  disclosureRecords,
  noChangeRoundTrip,
  publicHost,
  redactDisclosure,
  redactStubComments,
  reverseSubmission,
  scanDisclosure,
  transformConfigOf,
  unacknowledgedFindings,
  type AliasRule,
  type DisclosureFinding,
} from "../src/index.js";

const scan = (path: string, text: string, context = {}) =>
  scanDisclosure([{ path, text }], context).map(
    ({ kind, line, value }) => `${kind}@${line}:${value}`,
  );

test("each kind is found, with its line and value", () => {
  const text = [
    "/**",
    " * Copyright (c) 2021-2024 Orvanta Payments Ltd. All rights reserved.",
    " * @author Ada Lovelace <ada.lovelace@orvanta.io>",
    " * Docs: https://wiki.orvanta.internal/payments/fees?tab=1.",
    " * Ask in #payments-oncall or https://orvanta.slack.com/archives/C024BE91L",
    " * Tracked as PAY-1234; see TODO(grace) below.",
    " */",
    'const ledger = "ledger.orvanta-internal.com";',
    'const db = "10.1.2.3";',
    "// TODO @brendan: rounding",
  ].join("\n");
  assert.deepEqual(scan("src/fees.ts", text, { ticketKeys: ["PAY"] }), [
    "copyright@2:Orvanta Payments Ltd",
    "email@3:ada.lovelace@orvanta.io",
    "author@3:Ada Lovelace <ada.lovelace@orvanta.io>",
    "url@4:https://wiki.orvanta.internal/payments/fees?tab=1",
    "chat@5:#payments-oncall",
    "chat@5:https://orvanta.slack.com/archives/C024BE91L",
    "ticket@6:PAY-1234",
    "todo_name@6:grace",
    "host@8:ledger.orvanta-internal.com",
    "ip@9:10.1.2.3",
    "todo_name@10:brendan",
  ]);
  const [email] = scanDisclosure([{ path: "a.ts", text }]).filter(
    (finding) => finding.kind === "email",
  );
  assert.equal(email?.term, "orvanta.io", "an address's term is its domain");
});

test("common code, public hosts and placeholders are not findings", () => {
  const text = [
    'import { readFile } from "node:fs/promises";',
    'import io from "socket.io";',
    'import debounce from "lodash.debounce";',
    'const url = "http://localhost:3000/api";',
    'const docs = "https://nodejs.org/api/fs.html";',
    'const ts = "https://www.typescriptlang.org/tsconfig";',
    'const spec = "https://developer.mozilla.org/en-US/docs/Web";',
    'const repo = "https://github.com/nodejs/node";',
    'const reg = "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz";',
    'const mail = "user@example.com";',
    'const test = "ops@service.test";',
    'const local = "http://db:5432/app";',
    'const version = "1.2.3";',
    'const pkg = "@scope/pkg@1.2.3";',
    "const org = req.user.org;",
    "const id = user.id;",
    "const loop = 127.0.0.1;",
    'const doc = "192.0.2.10";',
    "const ratio = a / b / c;",
    "/** {@link Foo.bar} returns the UTF-8 bytes; see ISO-8601. */",
    "// TODO(perf): batch these",
    "// TODO(#123) and TODO(2024)",
    "// Copyright notice is in LICENSE",
    "// Licensed under http://www.apache.org/licenses/LICENSE-2.0",
    "interface Book { author: string; owner: string }",
    "const color = '#ff-00';",
  ].join("\n");
  assert.deepEqual(scan("src/app.ts", text, { ticketKeys: ["PAY"] }), []);
  assert.deepEqual(
    scan(
      "package-lock.json",
      '{"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha512-abc=="}',
    ),
    [],
  );
});

test("a bare host counts in code only inside a comment or a string", () => {
  assert.deepEqual(scan("src/a.ts", "const x = api.orvanta.com;"), []);
  assert.deepEqual(scan("src/a.ts", "// calls api.orvanta.com\n"), [
    "host@1:api.orvanta.com",
  ]);
  assert.deepEqual(scan("notes.yaml", "endpoint: api.orvanta.com\n"), [
    "host@1:api.orvanta.com",
  ]);
  // `io` needs three labels; `com` two.
  assert.deepEqual(scan("a.json", '{"a": "orvanta.io", "b": "orvanta.com"}'), [
    "host@1:orvanta.com",
  ]);
});

test("comment and string ranges see through regular expressions and templates", () => {
  const text =
    'const re = /"quoted"\\/x[/]/g; const t = `a ${"b"} c`; // note\n/* block */ x';
  const ranges = commentAndStringRanges(text).map(
    (range) => `${range.type}:${text.slice(range.start, range.end)}`,
  );
  assert.deepEqual(ranges, [
    'string:`a ${"b"} c`',
    "comment:// note",
    "comment:/* block */",
  ]);
  // After a keyword a slash starts an expression; an escape inside a
  // string and an unterminated comment end where they must.
  assert.deepEqual(
    commentAndStringRanges('return /x/.test(s); "a\\"b"; /* open').map(
      (range) => range.type,
    ),
    ["string", "comment"],
  );
});

test("text the name table wrote is the sanctioned public name", () => {
  const text = [
    "// @author A. Maintainer",
    "// See https://api.northwind.dev/v1 and ops@northwind.dev",
    "// Copyright 2024 Northwind",
  ].join("\n");
  assert.equal(scan("src/a.ts", text).length, 4);
  assert.deepEqual(
    scan("src/a.ts", text, {
      publicNames: [
        "A. Maintainer",
        "api.northwind.dev",
        "northwind.dev",
        "Northwind",
      ],
    }),
    [],
  );
  // Only whole words of a pseudonym: `ada` is no part of `Canada`.
  assert.deepEqual(
    scan("src/a.ts", "// TODO(ada): x", { publicNames: ["Canada"] }),
    ["todo_name@1:ada"],
  );
  // A host the caller adds is public too.
  assert.deepEqual(
    scan("src/a.ts", "// https://docs.stripe.com/api", {
      publicHosts: ["stripe.com"],
    }),
    [],
  );
});

test("names in prose, YAML and JSON author fields", () => {
  assert.deepEqual(scan("README.md", "Author: Grace Hopper\n#team-ledger\n"), [
    "author@1:Grace Hopper",
    "chat@2:#team-ledger",
  ]);
  assert.deepEqual(
    scan("package.json", '{"author": "Grace Hopper", "license": "MIT"}'),
    ["author@1:Grace Hopper"],
  );
  assert.deepEqual(scan("LICENSE", "© 2023 Orvanta GmbH\n"), [
    "copyright@1:Orvanta GmbH",
  ]);
  assert.deepEqual(scan("a.ts", "// SPDX-FileCopyrightText: Orvanta GmbH\n"), [
    "copyright@1:Orvanta GmbH",
  ]);
  // A licence template's placeholder names no one.
  assert.deepEqual(
    scan("LICENSE", "Copyright [yyyy] [name of copyright owner]\n"),
    [],
  );
  assert.deepEqual(scan("a.ts", "// Copyright 2024 <owner>\n"), []);
  // A slack: link and a Teams link are chat.
  assert.deepEqual(
    scan("a.md", "slack://channel?team=T1 https://teams.microsoft.com/l/x"),
    [
      "chat@1:https://teams.microsoft.com/l/x",
      "chat@1:slack://channel?team=T1",
    ],
  );
  // A file URL names no host; an IP's documentation range is public.
  assert.deepEqual(scan("a.md", "file:///tmp/x 198.51.100.7 203.0.113.9"), []);
});

test("public hosts: reserved names, subdomains and addresses", () => {
  assert.equal(publicHost("api.example.com"), true);
  assert.equal(publicHost("svc.invalid"), true);
  assert.equal(publicHost("box.localhost"), true);
  assert.equal(publicHost("gist.github.com"), true);
  assert.equal(publicHost("db"), true);
  assert.equal(publicHost("orvanta.io"), false);
  assert.equal(publicHost("127.0.0.1"), true);
  assert.equal(publicHost("10.0.0.1"), false);
  assert.equal(publicHost("docs.stripe.com", ["stripe.com"]), true);
});

test("acknowledgements: by kind and value, a host covering what sits on it", () => {
  const findings = scanDisclosure([
    {
      path: "a.ts",
      text: "// https://docs.stripe.com/api and https://status.stripe.com\n// ops@stripe.com\n// https://wiki.orvanta.internal/x",
    },
  ]);
  assert.equal(findings.length, 4);
  const left = unacknowledgedFindings(findings, [
    { kind: "host", value: "stripe.com" },
  ]);
  assert.deepEqual(
    left.map((finding) => finding.value),
    ["https://wiki.orvanta.internal/x"],
  );
  assert.equal(
    acknowledges(
      { kind: "url", value: "https://wiki.orvanta.internal/x" },
      left[0] as DisclosureFinding,
    ),
    true,
  );
  assert.equal(
    acknowledges(
      { kind: "email", value: "https://wiki.orvanta.internal/x" },
      left[0] as DisclosureFinding,
    ),
    false,
  );
  const records = disclosureRecords(findings, [
    { kind: "url", value: "https://wiki.orvanta.internal/x" },
  ]);
  assert.deepEqual(
    records.map((record) => record.acknowledged),
    [false, false, false, true],
  );
});

test("blockers name file, line, kind and value; hints name each term once", () => {
  const findings = scanDisclosure([
    {
      path: "src/a.ts",
      text: Array.from({ length: 7 }, (_, i) => `// ops${i}@orvanta.io`).join(
        "\n",
      ),
    },
  ]);
  const [blocker] = disclosureBlockers(findings);
  assert.equal(blocker?.code, "disclosure_findings");
  assert.equal(blocker?.file, "src/a.ts");
  assert.match(
    blocker?.detail ?? "",
    /src\/a\.ts:1 \(email ops0@orvanta\.io\)/,
  );
  assert.match(blocker?.detail ?? "", /and 2 more/);
  assert.deepEqual(disclosureHints(findings), [
    "orvanta.io (email; 7 times, first at src/a.ts:1)",
  ]);
  assert.deepEqual(disclosureHints(findings.slice(0, 1)), [
    "orvanta.io (email; at src/a.ts:1)",
  ]);
});

test("the gate counts unacknowledged findings beside vocabulary and credentials", () => {
  const findings = disclosureRecords(
    scanDisclosure([{ path: "a.ts", text: "// a@orvanta.io b@orvanta.io" }]),
    [{ kind: "email", value: "a@orvanta.io" }],
  );
  const gate = disclosureGate(
    [{ code: "secret_found", file: "x", detail: "" }],
    2,
    "build",
    { findings, total: 2, unacknowledged: 1 },
  );
  assert.equal(gate.status, "failed");
  assert.equal(gate.blocking, 2);
  assert.equal(gate.total, 2);
  assert.equal(gate.acknowledged, 1);
  assert.equal(gate.findings?.length, 2);
  const passed = disclosureGate([], 2, "build", {
    findings,
    total: 2,
    unacknowledged: 0,
  });
  assert.equal(passed.status, "passed");
});

test("generated prose is redacted; a stub only in its comments", () => {
  assert.equal(
    redactDisclosure(
      "Fix PAY-12: mail ops@orvanta.io, see https://wiki.orvanta.internal/a.",
      { ticketKeys: ["PAY"] },
    ),
    "Fix [ticket]: mail [email removed], see [link removed].",
  );
  // An acknowledged one stays; nothing found, the text is returned as is.
  assert.equal(
    redactDisclosure("Docs at https://docs.stripe.com/x", {
      acknowledgements: [{ kind: "host", value: "stripe.com" }],
    }),
    "Docs at https://docs.stripe.com/x",
  );
  const stub = [
    "/** Maintained by ops@orvanta.io. */",
    'export type Endpoint = "https://api.orvanta.io/v1";',
  ].join("\n");
  assert.equal(
    redactStubComments("src/ledger.d.ts", stub),
    [
      "/** Maintained by [email removed]. */",
      'export type Endpoint = "https://api.orvanta.io/v1";',
    ].join("\n"),
  );
  assert.equal(
    redactStubComments("a.d.ts", "export type A = 1;"),
    "export type A = 1;",
  );
});

test("a version's acknowledgements are part of its transform, none hashing as before", () => {
  const base = {
    aliasRules: [],
    dependencyChoices: {},
    acceptanceTests: [],
  };
  assert.equal("disclosureAcknowledgements" in transformConfigOf(base), false);
  assert.equal(
    "disclosureAcknowledgements" in
      transformConfigOf({ ...base, disclosureAcknowledgements: [] }),
    false,
  );
  assert.deepEqual(
    transformConfigOf({
      ...base,
      disclosureAcknowledgements: [{ kind: "host", value: "stripe.com" }],
    }).disclosureAcknowledgements,
    [{ kind: "host", value: "stripe.com" }],
  );
});

test("text rules for a host and an address hold the round trip and carry back", () => {
  const original = [
    "/**",
    " * Fee rules: https://wiki.orvanta.internal/payments/fees",
    " * @author ada.lovelace@orvanta.io",
    " */",
    "export const fee = 25;",
    "",
  ].join("\n");
  const table = (host: string): AliasRule[] => [
    { before: "orvanta", after: "northwind", kind: "path", paths: [] },
    { before: "wiki.orvanta.internal", after: host, kind: "text", paths: [] },
    {
      before: "ada.lovelace@orvanta.io",
      after: "maintainer@example.com",
      kind: "text",
      paths: [],
    },
  ];
  const sourceOf = (rules: AliasRule[]) => {
    const aliased = applyAliases(
      [{ path: "src/orvanta/fees.ts", text: original }],
      rules,
    );
    assert.ok(aliased.ok);
    return aliased.files[0];
  };
  const roundTripOf = (rules: AliasRule[]) =>
    noChangeRoundTrip({
      sources: [
        {
          projectPath: "src/northwind/fees.ts",
          repositoryPath: "src/orvanta/fees.ts",
          publicText: sourceOf(rules)?.text ?? null,
          repositoryText: original,
        },
      ],
      rules,
    });
  // A host renamed word for word teaches merge-back `example -> orvanta`:
  // the unchanged project carries back, but an added line would not.
  const wordForWord = table("wiki.example.com");
  assert.deepEqual(
    carryHazards(wordForWord).map((hazard) => hazard.rule),
    [2],
  );
  const held = roundTripOf(wordForWord);
  assert.equal(held.ok, false);
  assert.equal(held.problems[0]?.path, "pseudonym.lunox");
  assert.match(
    held.problems[0]?.reason ?? "",
    /example -> orvanta, com -> internal/,
  );
  // With a public name of another length, nothing is learned from it.
  const rules = table("wiki.example");
  assert.deepEqual(carryHazards(rules), []);
  const publicFile = sourceOf(rules);
  assert.equal(publicFile?.path, "src/northwind/fees.ts");
  assert.doesNotMatch(publicFile?.text ?? "", /orvanta/);
  assert.deepEqual(
    scanDisclosure(
      [{ path: publicFile?.path ?? "", text: publicFile?.text ?? "" }],
      { publicNames: rules.map((rule) => rule.after) },
    ),
    [],
  );
  const roundTrip = roundTripOf(rules);
  assert.equal(roundTrip.ok, true, JSON.stringify(roundTrip.problems));
  // A contributor's change on the comment's line, and an added line using
  // the public words, carry back in the repository's names.
  const changed = `${(publicFile?.text ?? "")
    .replace(
      "@author maintainer@example.com",
      "@author maintainer@example.com (fees)",
    )
    .replace("fee = 25", "fee = 30")}export const example = "wiki.example";\n`;
  const carried = reverseSubmission({
    submitted: [{ path: "src/northwind/fees.ts", text: changed }],
    publicText: (path) =>
      path === "src/northwind/fees.ts" ? (publicFile?.text ?? null) : null,
    repositoryText: (path) =>
      path === "src/orvanta/fees.ts" ? original : null,
    rules,
    renames: [{ from: "src/orvanta/fees.ts", to: "src/northwind/fees.ts" }],
    harness: [],
  });
  assert.deepEqual(carried.refused, []);
  const back = carried.files.find(
    (file) => file.path === "src/orvanta/fees.ts",
  );
  assert.match(
    back?.text ?? "",
    /https:\/\/wiki\.orvanta\.internal\/payments\/fees/,
  );
  assert.match(back?.text ?? "", /@author ada\.lovelace@orvanta\.io \(fees\)/);
  assert.match(back?.text ?? "", /fee = 30/);
  assert.match(
    back?.text ?? "",
    /export const example = "wiki\.orvanta\.internal";/,
  );
  // Rules of plain words, or of another kind, are not judged.
  assert.deepEqual(
    carryHazards([
      {
        before: "Orvanta Pay",
        after: "Northwind Shop",
        kind: "text",
        paths: [],
      },
      { before: "a.b", after: "c.d", kind: "identifier", paths: [] },
    ]),
    [],
  );
});

test("uploaded text built to backtrack scans in linear time", () => {
  const run = 50_000;
  const texts = [
    `// see https://example.org/a${"*".repeat(run)}x`,
    `// see https://example.org/a${"!".repeat(run)}x`,
    `# author:${"\t".repeat(run)}x`,
    `// TODO(${"\t".repeat(run)}`,
    ` * @author ${"*/".repeat(run)}`,
    ` * @author ${"-->".repeat(run)}`,
    ` * @author Ada${" ,".repeat(run)}`,
  ];
  const started = Date.now();
  for (const text of texts) scanDisclosure([{ path: "src/a.ts", text }]);
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.deepEqual(
    scan("src/a.ts", "// TODO(  grace  ): x\n// @author Ada Lovelace */ x"),
    ["todo_name@1:grace", "author@2:Ada Lovelace"],
  );
  assert.deepEqual(scan("page.html", "<!-- @author Ada Lovelace --!> -->"), [
    "author@1:Ada Lovelace",
  ]);
});
