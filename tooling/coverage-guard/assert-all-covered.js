#!/usr/bin/env node
/**
 * Fails if a compiled source file was never loaded by the test run.
 *
 * Node's coverage thresholds only police files the run actually imported: a
 * module nothing touches is absent from the report entirely, and the suite
 * passes at 100%. That makes `--test-coverage-*` good at catching a
 * half-tested file and blind to a wholly untested one — exactly backwards for
 * catching new code that arrived with no tests.
 *
 * So this compares what is on disk against what the report mentioned:
 *
 *   node --test ... > report.txt && assert-all-covered <dir> report.txt [exclude...]
 *
 * Note the `&&` and the report FILE. An earlier version of this piped the
 * report in, which silently broke the suite: npm runs scripts under `sh`
 * without `pipefail`, so a pipeline reports only the exit status of its last
 * command — a failing test run piped into a passing guard exits 0, and CI goes
 * green on red tests. Reading a file keeps the test command last in an `&&`
 * chain, where its status is the one that counts.
 *
 * `<dir>` is the compiled source directory (dist-test/src). Each `exclude` is
 * a path relative to it that is legitimately untestable — a barrel of
 * re-exports, or a CLI whose module body runs on import. Those must be named
 * explicitly, so skipping a file is a visible decision in package.json rather
 * than an accident.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [dir, reportPath, ...excluded] = process.argv.slice(2);

if (dir === undefined || reportPath === undefined) {
  console.error(
    "usage: assert-all-covered <compiled-src-dir> <report-file> [exclude...]",
  );
  process.exit(2);
}

function jsFilesIn(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...jsFilesIn(full));
    } else if (entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

let report;
try {
  report = readFileSync(reportPath, "utf8");
} catch (error) {
  console.error(
    `\nassert-all-covered: cannot read report ${reportPath}: ${String(error)}`,
  );
  process.exit(2);
}

let files;
try {
  files = jsFilesIn(dir);
} catch (error) {
  console.error(`\nassert-all-covered: cannot read ${dir}: ${String(error)}`);
  process.exit(2);
}

// Normalized to posix separators so the comparison works on Windows too.
const skip = new Set(excluded.map((path) => path.split(sep).join("/")));
const missing = files
  .map((file) => relative(dir, file).split(sep).join("/"))
  .filter((name) => !skip.has(name))
  // The reporter prints each covered file's path; a file the run never loaded
  // appears nowhere in it.
  .filter((name) => !report.includes(name));

if (missing.length > 0) {
  console.error(
    `\nassert-all-covered: ${missing.length} source file(s) were never loaded by a test, ` +
      `so coverage thresholds did not apply to them:\n` +
      missing.map((name) => `  ${name}`).join("\n") +
      `\n\nAdd a test that imports each one, or — if it genuinely cannot be ` +
      `tested (a re-export barrel, a CLI that runs on import) — list it as an ` +
      `argument to assert-all-covered in this package's test script.\n`,
  );
  process.exit(1);
}
