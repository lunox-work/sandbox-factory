import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandExitError, FileNotFoundError, TimeoutError } from "e2b";
import type { Sandbox, SandboxOpts } from "e2b";
import {
  hiddenTestFiles,
  privateTestArgv,
  SANDBOX_RUN_ARGV,
} from "sandbox-factory";
import {
  commandLine,
  createE2BProvider,
  E2B_JOB_BUDGET_MS,
  E2B_REGISTRY_HOST,
  e2bClient,
  meetsNodeRange,
  shellQuote,
} from "../src/evaluation/e2b.js";
import { limitJobs } from "../src/evaluation/limit.js";
import { fakeE2B } from "./e2b-fake.js";

const limits = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 };
const signal = () => new AbortController().signal;
const PREPARE = [
  "npm",
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];
const INSTALL = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
const WORK = "/home/user/job/work";

test("an e2b job starts registry-only, stages files, cuts egress after the install and tears down", async () => {
  process.env["SANDBOX_TEST_SECRET"] = "leak-value";
  try {
    const fake = fakeE2B((command) =>
      command.includes("'--test-reporter=tap'")
        ? { exitCode: 1, stdout: "not ok 1 - fails\n" }
        : command.startsWith("exec 'npm' 'run' 'build'")
          ? { stdout: "built\n", stderr: "warn\n" }
          : undefined,
    );
    const provider = createE2BProvider({
      client: fake.client,
      template: "node22-sandbox",
      budgetMs: 600_000,
      now: fake.now,
    });
    assert.equal(provider.name, "e2b");
    const job = await provider.create({ label: "sbv_1", signal: signal() });
    // A fresh sandbox per job, from the template, alive no longer than the
    // budget and a minute, reaching only the registry.
    assert.deepEqual(fake.created[0], {
      template: "node22-sandbox",
      timeoutMs: 660_000,
      metadata: { label: "sbv_1" },
      allowOut: [E2B_REGISTRY_HOST],
      signal: fake.created[0]?.signal,
    });
    assert.equal(job.id, "sbx_1");
    assert.deepEqual(job.environment, {
      provider: "e2b",
      environmentId: "node22-sandbox/node@22.12.0",
      templateDigest: null,
    });
    await job.stage([
      { path: "package.json", text: "{}" },
      { path: "src/app.ts", text: "export {};" },
      // As the build will have emitted them.
      { path: "tests/private/a.test.js", text: "/* a */" },
      { path: "tests/private/b.test.js", text: "/* b */" },
    ]);
    assert.deepEqual(
      fake.writes.map((write) => write.path),
      [
        `${WORK}/package.json`,
        `${WORK}/src/app.ts`,
        `${WORK}/tests/private/a.test.js`,
        `${WORK}/tests/private/b.test.js`,
      ],
    );
    assert.equal(job.egressCut?.(), false);
    await job.exec({ argv: PREPARE, env: {}, limits });
    fake.writes.length = 0;
    assert.equal(await job.read("package.json"), "{}");
    assert.equal(await job.read("missing.json"), null);
    await job.exec({ argv: INSTALL, env: {}, limits });
    // The registry stays reachable for the preparation and the install only.
    assert.equal(fake.denied(), 0);
    assert.equal(job.egressCut?.(), false);
    const built = await job.exec({
      argv: ["npm", "run", "build"],
      env: { FIXTURE: "value" },
      limits,
    });
    assert.equal(fake.denied(), 1);
    assert.equal(job.egressCut?.(), true);
    assert.deepEqual(
      { ...built, durationMs: 0 },
      {
        exitCode: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: "built\n",
        stderr: "warn\n",
        durationMs: 0,
      },
    );
    // A hidden run before the seal is refused.
    await assert.rejects(
      job.exec({
        argv: privateTestArgv("tests/private/a.test.ts"),
        env: {},
        limits,
        hidden: { entry: "tests/private/a.test.js", load: "memory" },
      }),
      /sealed/,
    );
    // The seal takes every hidden test's files out of the tree, keeping
    // their text in the worker, and root copies what is left out of the
    // user's reach.
    const sealFrom = fake.runs.length;
    await job.seal([
      ...hiddenTestFiles("tests/private/a.test.ts"),
      ...hiddenTestFiles("tests/private/b.test.ts"),
    ]);
    await assert.rejects(job.seal([]), /sealed once/);
    const sealing = fake.runs.slice(sealFrom);
    assert.equal(sealing.length, 2);
    assert.match(sealing[0]?.command ?? "", /^rm -f -- /);
    assert.match(
      sealing[0]?.command ?? "",
      /'\/home\/user\/job\/work\/tests\/private\/a\.test\.js'/,
    );
    assert.equal(sealing[0]?.user, undefined);
    assert.equal(
      sealing[1]?.command,
      "mkdir -p -m 700 '/root/sandbox-job' && rm -rf '/root/sandbox-job/pristine' && cp -a '/home/user/job/work' '/root/sandbox-job/pristine' && chown -R -h root:root '/root/sandbox-job/pristine'",
    );
    assert.equal(sealing[1]?.user, "root");
    await job.exec({ argv: SANDBOX_RUN_ARGV.test, env: {}, limits });
    // Each hidden test runs from a fresh copy of the sealed tree, never the
    // working directory, with its own test alone, loaded from memory.
    fake.writes.length = 0;
    const first = await job.exec({
      argv: privateTestArgv("tests/private/a.test.ts"),
      env: {},
      limits,
      hidden: { entry: "tests/private/a.test.js", load: "memory" },
    });
    assert.equal(first.exitCode, 1);
    assert.equal(first.stdout, "not ok 1 - fails\n");
    assert.deepEqual(
      fake.writes.map((write) => write.path),
      [
        "/home/user/job/fresh/.sandbox-hidden/a.test.mjs",
        "/home/user/job/fresh/.sandbox-hidden/a.payload",
      ],
    );
    assert.equal(fake.writes[1]?.text, "/* a */");
    fake.writes.length = 0;
    await job.exec({
      argv: privateTestArgv("tests/private/b.test.ts"),
      env: {},
      limits,
      hidden: { entry: "tests/private/b.test.js", load: "memory" },
    });
    assert.equal(fake.writes[1]?.text, "/* b */");
    assert.ok(fake.writes.every((write) => !write.text.includes("/* a */")));
    assert.equal(fake.denied(), 1);
    const tests = fake.runs.filter((run) =>
      run.command.includes("'--test-reporter=tap'"),
    );
    assert.deepEqual(
      tests.map((run) => [run.cwd, run.command]),
      [
        [
          "/home/user/job/fresh",
          "exec 'node' '--env-file=sandbox.env' '--test' '--test-reporter=tap' '.sandbox-hidden/a.test.mjs'",
        ],
        [
          "/home/user/job/fresh",
          "exec 'node' '--env-file=sandbox.env' '--test' '--test-reporter=tap' '.sandbox-hidden/b.test.mjs'",
        ],
      ],
    );
    for (const at of tests.map((run) => fake.runs.indexOf(run))) {
      const copy = fake.runs[at - 1];
      assert.equal(
        copy?.command,
        "rm -rf '/home/user/job/fresh' && cp -a '/root/sandbox-job/pristine' '/home/user/job/fresh' && rm -rf '/home/user/job/fresh/.sandbox-hidden' && mkdir '/home/user/job/fresh/.sandbox-hidden' && chown -R -h user: '/home/user/job/fresh'",
      );
      assert.equal(copy?.user, "root");
    }
    // Every command the caller ran is followed by a sweep of what it left.
    const execs = fake.runs.filter((run) => run.command.startsWith("exec "));
    assert.equal(execs.length, 6);
    for (const run of execs)
      assert.equal(
        fake.runs[fake.runs.indexOf(run) + 1]?.command,
        "kill -KILL -1 2>/dev/null; exit 0",
      );
    // The deny-all lands before the first command that is not the install.
    const order = fake.events.filter(
      (event) => event === "deny" || event.startsWith("exec "),
    );
    assert.deepEqual(order.slice(0, 4), [
      commandLine(PREPARE),
      commandLine(INSTALL),
      "deny",
      commandLine(["npm", "run", "build"]),
    ]);
    // No variable of the worker's reaches a command: a fixed set and the
    // command's fixture values.
    for (const run of fake.runs) {
      assert.equal(run.envs["SANDBOX_TEST_SECRET"], undefined);
      assert.equal(run.envs["PATH"], undefined);
      assert.equal(run.envs["E2B_API_KEY"], undefined);
      assert.equal(run.envs["HOME"], "/home/user");
      assert.equal(
        run.envs["npm_config_registry"],
        "https://registry.npmjs.org/",
      );
      assert.ok(
        Object.keys(run.envs).every((key) =>
          [
            "HOME",
            "LANG",
            "NO_COLOR",
            "CI",
            "npm_config_registry",
            "npm_config_update_notifier",
            "npm_config_fund",
            "npm_config_audit",
            "FIXTURE",
          ].includes(key),
        ),
        Object.keys(run.envs).join(","),
      );
    }
    assert.equal(
      fake.runs.find((run) => run.command.includes("'build'"))?.envs["FIXTURE"],
      "value",
    );
    assert.ok(
      JSON.stringify([fake.runs, fake.writes, fake.created]).includes(
        "leak-value",
      ) === false,
    );
    await assert.rejects(
      job.stage([{ path: "late.txt", text: "" }]),
      /staged before it runs/,
    );
    await job.destroy();
    await job.destroy();
    assert.equal(fake.killed(), 1);
    await assert.rejects(job.exec({ argv: ["true"], limits }), /destroyed/);
  } finally {
    delete process.env["SANDBOX_TEST_SECRET"];
  }
});

test("a layout's hidden test runs in a fresh copy whatever its argv; one read from disk goes back at its path", async () => {
  const fake = fakeE2B(() => undefined);
  const provider = createE2BProvider({
    client: fake.client,
    template: "node22-sandbox",
    budgetMs: 600_000,
    now: fake.now,
  });
  const job = await provider.create({ label: "sbv_up", signal: signal() });
  await job.stage([
    { path: "package.json", text: "{}" },
    { path: "apps/shop/src/cart.accept.test.js", text: "/* node */" },
    { path: "apps/shop/src/cart.vitest.test.ts", text: "/* vitest */" },
  ]);
  await job.exec({ argv: INSTALL, env: {}, limits });
  await job.seal([
    "apps/shop/src/cart.accept.test.js",
    "apps/shop/src/cart.vitest.test.ts",
  ]);
  const hidden = [
    "node",
    "--env-file=carveout.env",
    "--import=./carveout/assets.js",
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    "apps/shop/src/cart.accept.test.js",
  ];
  await job.exec({ argv: ["node", "carveout/test.js"], env: {}, limits });
  await job.exec({
    argv: hidden,
    env: {},
    limits,
    hidden: { entry: "apps/shop/src/cart.accept.test.js", load: "memory" },
  });
  fake.writes.length = 0;
  const vitest = [
    "node_modules/.bin/vitest",
    "run",
    "apps/shop/src/cart.vitest.test.ts",
  ];
  await job.exec({
    argv: vitest,
    env: {},
    limits,
    hidden: { entry: "apps/shop/src/cart.vitest.test.ts", load: "disk" },
  });
  // Vitest reads its own file: it goes back at its path, argv unchanged.
  assert.deepEqual(fake.writes, [
    {
      path: "/home/user/job/fresh/apps/shop/src/cart.vitest.test.ts",
      text: "/* vitest */",
    },
  ]);
  const runs = fake.runs.filter((run) => run.command.startsWith("exec "));
  assert.deepEqual(
    runs.map((run) => run.cwd),
    [WORK, WORK, "/home/user/job/fresh", "/home/user/job/fresh"],
  );
  assert.match(
    runs[2]?.command ?? "",
    /'\.sandbox-hidden\/cart\.accept\.test\.mjs'$/,
  );
  assert.equal(runs[3]?.command, commandLine(vitest));
  await job.destroy();
});

test("an e2b job refuses paths outside its directory and empty commands", async () => {
  const fake = fakeE2B();
  const job = await createE2BProvider({
    client: fake.client,
    now: fake.now,
  }).create({ label: "x", signal: signal() });
  assert.equal(fake.created[0]?.template, "base");
  assert.equal(fake.created[0]?.timeoutMs, E2B_JOB_BUDGET_MS + 60_000);
  for (const path of ["../escape.txt", "/etc/passwd", "a/../../b", "", "a\0b"])
    await assert.rejects(job.stage([{ path, text: "" }]), /leaves the job/);
  await assert.rejects(job.read("../secret"), /leaves the job/);
  await assert.rejects(job.exec({ argv: [], limits }), /needs an executable/);
  await assert.rejects(
    job.exec({ argv: ["ls"], cwd: "../..", limits }),
    /leaves the job/,
  );
  const nested = await job.exec({ argv: ["pwd"], cwd: "dir", limits });
  assert.equal(nested.exitCode, 0);
  assert.equal(fake.runs.at(-2)?.cwd, `${WORK}/dir`);
  await job.destroy();
});

test("an e2b job caps output, reports its own timeouts and fails past its budget", async () => {
  const fake = fakeE2B((command) => {
    if (command.includes("'loud'"))
      return { stdout: "x".repeat(30), stderr: "y" };
    if (command.includes("'slow'")) return { timedOut: true, advanceMs: 2_000 };
    return undefined;
  });
  const job = await createE2BProvider({
    client: fake.client,
    budgetMs: 10_000,
    now: fake.now,
  }).create({ label: "x", signal: signal() });
  const loud = await job.exec({
    argv: ["loud"],
    limits: { timeoutMs: 1_000, maxOutputBytes: 10 },
  });
  assert.equal(loud.stdout, "x".repeat(10));
  assert.equal(loud.stderr, "");
  assert.equal(loud.outputTruncated, true);
  // A step's own timeout is the step's result, with what it left killed.
  const slow = await job.exec({
    argv: ["slow"],
    limits: { timeoutMs: 1_000, maxOutputBytes: 10 },
  });
  assert.deepEqual(
    { exitCode: slow.exitCode, timedOut: slow.timedOut },
    { exitCode: null, timedOut: true },
  );
  assert.equal(fake.runs.at(-1)?.command, "kill -KILL -1 2>/dev/null; exit 0");
  assert.equal(fake.runs.at(-2)?.timeoutMs, 1_000);
  // A command is bounded by what is left of the budget, and one cut short
  // by it fails the job rather than the step.
  const budgetFake = fakeE2B((command) =>
    command.includes("'hang'")
      ? { timedOut: true, advanceMs: 5_000 }
      : undefined,
  );
  const tight = await createE2BProvider({
    client: budgetFake.client,
    budgetMs: 3_000,
    now: budgetFake.now,
  }).create({ label: "x", signal: signal() });
  await assert.rejects(
    tight.exec({ argv: ["hang"], limits }),
    /past its budget/,
  );
  assert.equal(budgetFake.runs.at(-2)?.timeoutMs, 2_998);
  await assert.rejects(
    tight.exec({ argv: ["next"], limits }),
    /past its budget/,
  );
  await tight.destroy();
  assert.equal(budgetFake.killed(), 1);
  await job.destroy();
});

test("an e2b job fails closed: no cut, no command; a template without Node 22 is killed", async () => {
  const fake = fakeE2B(undefined, { denyFails: true });
  const job = await createE2BProvider({
    client: fake.client,
    now: fake.now,
  }).create({ label: "x", signal: signal() });
  await assert.rejects(
    job.exec({ argv: ["npm", "test"], limits }),
    /network update/,
  );
  assert.equal(job.egressCut?.(), false);
  assert.equal(
    fake.runs.some((run) => run.command.startsWith("exec ")),
    false,
  );
  await job.destroy();
  for (const node of ["v20.18.0", "v22.11.0", ""]) {
    const old = fakeE2B(undefined, { node });
    await assert.rejects(
      createE2BProvider({ client: old.client, now: old.now }).create({
        label: "x",
        signal: signal(),
      }),
      /the toolchain needs >=22\.12/,
    );
    assert.equal(old.killed(), 1);
  }
  const broken = fakeE2B();
  // A probe that fails outright kills the sandbox too.
  const failing = createE2BProvider({
    client: {
      async create(spec) {
        const sandbox = await broken.client.create(spec);
        return {
          ...sandbox,
          run: async (command, options) =>
            command.startsWith("mkdir")
              ? { exitCode: 1, timedOut: false }
              : sandbox.run(command, options),
        };
      },
    },
    now: broken.now,
  });
  await assert.rejects(
    failing.create({ label: "x", signal: signal() }),
    /housekeeping failed/,
  );
  assert.equal(broken.killed(), 1);
  const down = fakeE2B(undefined, { createFails: true });
  await assert.rejects(
    createE2BProvider({ client: down.client }).create({
      label: "x",
      signal: signal(),
    }),
    /E2B down/,
  );
  const aborted = new AbortController();
  aborted.abort(new Error("stopped"));
  await assert.rejects(
    createE2BProvider({ client: down.client }).create({
      label: "x",
      signal: aborted.signal,
    }),
    /stopped/,
  );
});

test("an aborted run stops the job's commands", async () => {
  const fake = fakeE2B();
  const controller = new AbortController();
  const job = await createE2BProvider({
    client: fake.client,
    now: fake.now,
  }).create({ label: "x", signal: controller.signal });
  controller.abort(new Error("run stopped"));
  await assert.rejects(
    job.exec({ argv: ["npm", "ci"], limits }),
    /run stopped/,
  );
  await job.destroy();
  assert.equal(fake.killed(), 1);
});

test("the limiter keeps a job's egress record", async () => {
  const fake = fakeE2B();
  const job = await limitJobs(
    createE2BProvider({ client: fake.client, now: fake.now }),
    1,
  ).create({ label: "x", signal: signal() });
  assert.equal(job.egressCut?.(), false);
  // An install that would run packages' scripts is not the trusted one.
  await job.exec({ argv: ["npm", "ci"], limits });
  assert.equal(job.egressCut?.(), true);
  await job.destroy();
});

test("commands are quoted words and Node is checked by range", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(
    commandLine(["node", "-e", "console.log('$HOME')"]),
    `exec 'node' '-e' 'console.log('\\''$HOME'\\'')'`,
  );
  assert.equal(meetsNodeRange("v22.12.0"), true);
  assert.equal(meetsNodeRange("v24.1.0\n"), true);
  assert.equal(meetsNodeRange("v22.11.9"), false);
  assert.equal(meetsNodeRange("v21.99.0"), false);
  assert.equal(meetsNodeRange("node: not found"), false);
});

/** A stand-in for the SDK's `Sandbox`, recording what the adapter asks. */
function fakeSdk(
  behaviour: {
    run?: (command: string) => unknown;
    info?: { type: string; size: number } | Error;
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const sandbox = {
    sandboxId: "sbx_real",
    files: {
      write: async (...args: unknown[]) => {
        calls.push({ method: "files.write", args });
        return [];
      },
      getInfo: async (...args: unknown[]) => {
        calls.push({ method: "files.getInfo", args });
        if (behaviour.info instanceof Error) throw behaviour.info;
        return behaviour.info ?? { type: "file", size: 5 };
      },
      read: async (...args: unknown[]) => {
        calls.push({ method: "files.read", args });
        return "hello";
      },
    },
    commands: {
      run: async (command: string, options: unknown) => {
        calls.push({ method: "commands.run", args: [command, options] });
        const outcome = behaviour.run?.(command);
        if (outcome instanceof Error) throw outcome;
        return { exitCode: 0, stdout: undefined, stderr: undefined };
      },
    },
    updateNetwork: async (...args: unknown[]) => {
      calls.push({ method: "updateNetwork", args });
    },
    kill: async () => {
      calls.push({ method: "kill", args: [] });
      return false;
    },
  };
  const sdk = {
    create: async (template: string, options: SandboxOpts) => {
      calls.push({ method: "create", args: [template, options] });
      return sandbox as unknown as Sandbox;
    },
  };
  return { sdk, calls };
}

test("the SDK adapter sends the key to E2B only, registry-only egress, and maps command endings", async () => {
  const exit = (exitCode: number) =>
    new CommandExitError({ exitCode, stdout: "", stderr: "", error: "" });
  const { sdk, calls } = fakeSdk({
    run: (command) =>
      command === "fails"
        ? exit(2)
        : command === "killed"
          ? exit(-1)
          : command === "slow"
            ? new TimeoutError("deadline")
            : command === "broken"
              ? new Error("transport")
              : undefined,
  });
  const client = e2bClient("e2b_test_key", sdk);
  const controller = new AbortController();
  const sandbox = await client.create({
    template: "base",
    timeoutMs: 1_000,
    metadata: { label: "x" },
    allowOut: [E2B_REGISTRY_HOST],
    signal: controller.signal,
  });
  const created = calls[0]?.args as [string, SandboxOpts];
  assert.equal(created[0], "base");
  assert.equal(created[1].apiKey, "e2b_test_key");
  assert.equal(created[1].timeoutMs, 1_000);
  assert.deepEqual(created[1].network, {
    allowOut: [E2B_REGISTRY_HOST],
    denyOut: ["0.0.0.0/0"],
  });
  assert.equal(created[1].envs, undefined);
  assert.equal(sandbox.sandboxId, "sbx_real");
  await sandbox.write([{ path: "/home/user/job/work/a", text: "b" }]);
  assert.deepEqual(calls.at(-1), {
    method: "files.write",
    args: [[{ path: "/home/user/job/work/a", data: "b" }], { user: "user" }],
  });
  const options = {
    cwd: "/home/user",
    envs: { HOME: "/home/user" },
    timeoutMs: 500,
    signal: controller.signal,
    onStdout: () => undefined,
    onStderr: () => undefined,
  };
  assert.deepEqual(await sandbox.run("ok", options), {
    exitCode: 0,
    timedOut: false,
  });
  const ran = calls.at(-1)?.args[1] as Record<string, unknown>;
  assert.equal(ran["user"], "user");
  assert.equal(ran["retainOutput"], false);
  assert.equal(ran["timeoutMs"], 500);
  assert.deepEqual(ran["envs"], { HOME: "/home/user" });
  // Only the provider's own copies of the sealed tree run as root.
  await sandbox.run("ok", { ...options, user: "root" });
  assert.equal(
    (calls.at(-1)?.args[1] as Record<string, unknown>)["user"],
    "root",
  );
  assert.deepEqual(await sandbox.run("fails", options), {
    exitCode: 2,
    timedOut: false,
  });
  assert.deepEqual(await sandbox.run("killed", options), {
    exitCode: null,
    timedOut: false,
  });
  assert.deepEqual(await sandbox.run("slow", options), {
    exitCode: null,
    timedOut: true,
  });
  await assert.rejects(sandbox.run("broken", options), /transport/);
  controller.abort(new Error("stopped"));
  await assert.rejects(sandbox.run("fails", options), /stopped/);
  assert.equal(await sandbox.readText("/home/user/job/work/a", 10), "hello");
  await sandbox.denyEgress();
  assert.deepEqual(calls.at(-1), {
    method: "updateNetwork",
    args: [{ denyOut: ["0.0.0.0/0"] }],
  });
  await sandbox.kill();
  assert.equal(calls.at(-1)?.method, "kill");
  assert.equal(
    JSON.stringify(
      calls.filter((call) => call.method !== "create").map((call) => call.args),
    ).includes("e2b_test_key"),
    false,
  );
});

test("the SDK adapter reads back only regular files within the cap", async () => {
  for (const [info, expected] of [
    [{ type: "symlink", size: 5 }, null],
    [{ type: "dir", size: 5 }, null],
    [{ type: "file", size: 50 }, null],
    [new FileNotFoundError("gone"), null],
    [{ type: "file", size: 5 }, "hello"],
  ] as const) {
    const { sdk } = fakeSdk({ info });
    const sandbox = await e2bClient("k", sdk).create({
      template: "base",
      timeoutMs: 1,
      metadata: {},
      allowOut: [],
      signal: signal(),
    });
    assert.equal(await sandbox.readText("/f", 10), expected);
  }
  const { sdk } = fakeSdk({ info: new Error("transport") });
  const sandbox = await e2bClient("k", sdk).create({
    template: "base",
    timeoutMs: 1,
    metadata: {},
    allowOut: [],
    signal: signal(),
  });
  await assert.rejects(sandbox.readText("/f", 10), /transport/);
});
