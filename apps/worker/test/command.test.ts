import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/command.js";
import { CommandError } from "../src/errors.js";
test("parser environment excludes platform credentials", async () => {
  const out = await command(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({db:process.env.DATABASE_URL,seed:process.env.PYTHONHASHSEED}));process.stderr.write('ignored')",
    ],
    { signal: new AbortController().signal },
  );
  assert.deepEqual(JSON.parse(out), { seed: "0" });
});
test("command failures, missing executables and excessive output reject", async () => {
  const options = { signal: new AbortController().signal };
  await assert.rejects(
    command(process.execPath, ["-e", "process.exit(7)"], options),
    (e) => e instanceof CommandError && e.exitCode === 7,
  );
  await assert.rejects(command("/nonexistent-parser", [], options));
  await assert.rejects(
    command(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(200000));setInterval(()=>{},100)",
      ],
      options,
    ),
    CommandError,
  );
});
test("aborting terminates the parser process group", async () => {
  const abort = new AbortController();
  const pending = command(process.execPath, ["-e", "setInterval(()=>{},100)"], {
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(new Error("lease lost")), 50);
  await assert.rejects(pending, /lease lost/);
  assert.throws(
    () => command(process.execPath, [], { signal: abort.signal }),
    /lease lost/,
  );
});
