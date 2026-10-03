import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactKind, createGraphifyAdapter } from "../src/tools/graphify.js";
import { AnalysisError } from "../src/errors.js";
import { toolContext } from "./helpers.js";
test("Graphify output paths map to artifact kinds", () => {
  assert.deepEqual(
    [
      "graph.json",
      "graph.html",
      "GRAPH_REPORT.md",
      "manifest.json",
      "wiki/page.md",
      "extra.txt",
    ].map(artifactKind),
    ["graph_json", "graph_html", "report_md", "manifest", "wiki_page", "other"],
  );
});
test("adapter captures all outputs and attaches the manifest to the graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-adapter-"));
  const out = join(root, "out");
  const messages: string[] = [];
  try {
    const adapter = createGraphifyAdapter({
      python: "fixture-python",
      scriptPath: "driver.py",
      execute: async (cmd, args) => {
        assert.equal(cmd, "fixture-python");
        assert.equal(args[0], "driver.py");
        await mkdir(join(out, "wiki"), { recursive: true });
        for (const path of [
          "graph.json",
          "graph.html",
          "GRAPH_REPORT.md",
          "wiki/index.md",
          "extra.txt",
        ])
          await writeFile(join(out, path), "{}");
        await writeFile(join(out, "manifest.json"), '{"nodes":2}');
        return "";
      },
    });
    const files = await adapter.run({
      ...toolContext(),
      sourceDir: root,
      outDir: out,
      params: { deadlineMinutes: 30 },
      signal: new AbortController().signal,
      log: (line) => messages.push(line),
    });
    assert.equal(files.length, 6);
    assert.deepEqual(files.find((f) => f.kind === "graph_json")?.meta, {
      nodes: 2,
    });
    assert.equal(messages.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing required outputs and symlink outputs fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-invalid-"));
  const input = {
    ...toolContext(),
    sourceDir: root,
    outDir: root,
    params: { deadlineMinutes: 30 },
    signal: new AbortController().signal,
    log: () => {},
  };
  try {
    await assert.rejects(
      createGraphifyAdapter({ execute: async () => "" }).run(input),
      AnalysisError,
    );
    await symlink("/etc/passwd", join(root, "secret"));
    await assert.rejects(
      createGraphifyAdapter({ execute: async () => "" }).run(input),
      AnalysisError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
