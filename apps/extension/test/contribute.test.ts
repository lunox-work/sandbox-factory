import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ApiError } from "@sandbox-factory/client";
import type {
  ContributionDto,
  ContributionSubmissionDto,
  FolderPreviewDto,
} from "@sandbox-factory/shared";

import {
  ACTIONS,
  createContributeCommands,
  failureText,
  nextAttempt,
  type ContributorApi,
} from "../src/contribute.js";
import { tokenKeyFor } from "../src/origin.js";
import { listZip, readZipEntry, zip } from "../src/zip.js";
import { fakeHost, type FakeHostOptions } from "./fake-host.js";
import { contribution, descriptor, submission } from "./fixtures.js";
import { text } from "./zip-fixtures.js";

const PLATFORM = "https://platform.lunox.work";
const KEY = tokenKeyFor(PLATFORM);
const GOOD = "lnxc_good";

const made: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lunox-contribute-"));
  made.push(dir);
  return dir;
}
after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const PROJECT: Record<string, string> = {
  "package.json": "{}\n",
  "sandbox-task.json": JSON.stringify(descriptor),
  "src/app.ts": "export const app = 0;\n",
  "tests/public/spec.test.ts": "test('x');\n",
};
const ARCHIVE = zip(
  Object.entries(PROJECT).map(([name, value]) => ({
    name: `sbx_1-v2/${name}`,
    bytes: text(value),
  })),
);

const changed: FolderPreviewDto = {
  files: [{ path: "src/app.ts", change: "changed" }],
  ignored: [],
  skipped: 1,
  missing: [],
  refused: [],
};

interface ApiOptions {
  contributions?: ContributionDto[];
  archive?: Uint8Array<ArrayBuffer>;
  submissions?: ContributionSubmissionDto[];
  /** What polling a submission answers, in turn; the last repeats. */
  polls?: (ContributionSubmissionDto | Error)[];
  preview?: FolderPreviewDto;
  submitError?: Error;
}

/** A fake platform: the bearer must be `lnxc_good`, and every call is recorded. */
function fakePlatform(options: ApiOptions = {}) {
  const calls: string[] = [];
  const uploads: {
    route: string;
    retryOf?: string;
    names: string[];
    bytes: Uint8Array;
  }[] = [];
  const polls = [...(options.polls ?? [])];
  const connect = (getToken: () => PromiseLike<string | null>) => {
    const authorized = async () => {
      if ((await getToken()) !== GOOD)
        throw new ApiError(401, "Sign in.", "unauthorized");
    };
    const upload = async (route: string, folder: Blob, retryOf?: string) => {
      const bytes = new Uint8Array(await folder.arrayBuffer());
      uploads.push({
        route,
        ...(retryOf === undefined ? {} : { retryOf }),
        names: listZip(bytes).map((entry) => entry.name),
        bytes,
      });
      return bytes;
    };
    const api: ContributorApi = {
      contributions: async () => {
        calls.push("contributions");
        await authorized();
        return options.contributions ?? [contribution()];
      },
      contributionArchive: async (versionId) => {
        calls.push(`archive ${versionId}`);
        await authorized();
        return {
          blob: new Blob([options.archive ?? ARCHIVE]),
          filename: "sbx_1-v2.zip",
          etag: null,
        };
      },
      contributionHandout: async (versionId) => {
        calls.push(`handout ${versionId}`);
        await authorized();
        return {
          versionId,
          run: null,
          files: Object.keys(PROJECT).map((path) => ({
            path,
            sizeBytes: 1,
            sha256: "0".repeat(64),
          })),
          hiddenTests: 1,
          hiddenSha256: null,
          hiddenSha256Version: 2,
        } as never;
      },
      contributionSubmissions: async (versionId) => {
        calls.push(`submissions ${versionId}`);
        await authorized();
        return options.submissions ?? [];
      },
      contributionSubmission: async (_versionId, id) => {
        calls.push(`poll ${id}`);
        await authorized();
        const next = polls.length > 1 ? polls.shift() : polls[0];
        if (next === undefined) throw new Error("no poll scripted");
        if (next instanceof Error) throw next;
        return next;
      },
      previewContributionFolder: async (versionId, folder, retryOf) => {
        calls.push(
          `preview ${versionId}${retryOf === undefined ? "" : ` retry ${retryOf}`}`,
        );
        await authorized();
        await upload("preview", folder, retryOf);
        return options.preview ?? changed;
      },
      submitContributionFolder: async (versionId, folder, retryOf) => {
        calls.push(
          `submit ${versionId}${retryOf === undefined ? "" : ` retry ${retryOf}`}`,
        );
        await authorized();
        await upload("submit", folder, retryOf);
        if (options.submitError !== undefined) throw options.submitError;
        return submission({
          id: "sbm_9",
          status: "queued",
          retryOf: retryOf ?? null,
        });
      },
      regradeContribution: async (_versionId, id) => {
        calls.push(`regrade ${id}`);
        await authorized();
        return submission({ id, status: "queued" });
      },
    };
    return api;
  };
  return { connect, calls, uploads };
}

function setup(
  hostOptions: FakeHostOptions = {},
  apiOptions: ApiOptions = {},
  extra: { maxPolls?: number } = {},
) {
  const host = fakeHost({ secrets: { [KEY]: GOOD }, ...hostOptions });
  const platform = fakePlatform(apiOptions);
  const commands = createContributeCommands({
    host: host.host,
    platformUrl: PLATFORM,
    tokenKey: KEY,
    connect: platform.connect,
    pollMs: { first: 1, then: 2 },
    ...extra,
  });
  return { ...host, ...platform, commands };
}

/** An unpacked contribution folder with its note, as Open contribution leaves it. */
async function contributionFolder(
  changes: Record<string, string> = {},
): Promise<string> {
  const dir = await scratch();
  const files: Record<string, string> = {
    ...PROJECT,
    ".lunox/contribution.json": JSON.stringify({
      schemaVersion: 1,
      versionId: "sbv_1",
      root: "sbx_1-v2",
      platformUrl: PLATFORM,
    }),
    "node_modules/typescript/index.js": "x",
    "src/app.js": "built",
    ...changes,
  };
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split("/").slice(0, -1)), {
      recursive: true,
    });
    await writeFile(join(dir, ...path.split("/")), value);
  }
  return dir;
}

test("signing in checks a pasted contributor token against the platform before keeping it", async () => {
  const made = setup({
    secrets: {},
    choices: [ACTIONS.makeToken],
    inputs: [`  ${GOOD}  `],
  });
  assert.equal(await made.commands.signIn(), true);
  assert.deepEqual(made.external, [
    `${PLATFORM}/contributions#contributor-tokens`,
  ]);
  assert.equal(made.state.passwordPrompts, 1);
  assert.equal(made.secrets[KEY], GOOD);
  assert.match(
    made.messages.at(-1)?.text ?? "",
    /signed in to .*: 1 contribution/,
  );
  // Not a contributor token: refused before any request.
  const wrong = setup({
    secrets: {},
    choices: [ACTIONS.pasteToken],
    inputs: ["lnx_workspace"],
  });
  assert.equal(await wrong.commands.signIn(), false);
  assert.deepEqual(wrong.calls, []);
  assert.match(wrong.messages[0]?.text ?? "", /starts with lnxc_/);
  // Revoked or for another platform: the platform says so, nothing is kept.
  const revoked = setup({
    secrets: {},
    choices: [ACTIONS.pasteToken],
    inputs: ["lnxc_revoked"],
  });
  assert.equal(await revoked.commands.signIn(), false);
  assert.deepEqual(revoked.secrets, {});
  assert.match(
    revoked.messages[0]?.text ?? "",
    /not signed in: The platform refused your token/,
  );
  // Every prompt can be dismissed.
  for (const options of [
    { choices: [undefined] },
    { choices: [ACTIONS.pasteToken], inputs: [undefined] },
    { choices: [ACTIONS.pasteToken], inputs: ["  "] },
  ]) {
    const dismissed = setup({ secrets: {}, ...options });
    assert.equal(await dismissed.commands.signIn(), false);
    assert.deepEqual(dismissed.messages, []);
  }
  // Signing out forgets the token and the status.
  const out = setup();
  await out.commands.signOut();
  assert.deepEqual(out.secrets, {});
  assert.deepEqual(out.statuses, [undefined]);
  assert.match(
    out.messages[0]?.text ?? "",
    /revoke it on your Contributions page/,
  );
});

test("open contribution unpacks the archive into an empty folder, notes it and opens it", async () => {
  const dir = await scratch();
  const made = setup({
    choices: ["Fix the widget"],
    folderPicks: [dir],
    answers: [ACTIONS.openNewWindow],
  });
  await made.commands.openContribution();
  assert.deepEqual(made.offered[0]?.labels, ["Fix the widget"]);
  assert.equal(
    await readFile(join(dir, "src", "app.ts"), "utf8"),
    "export const app = 0;\n",
  );
  const note = JSON.parse(
    await readFile(join(dir, ".lunox", "contribution.json"), "utf8"),
  );
  assert.deepEqual(note, {
    schemaVersion: 1,
    versionId: "sbv_1",
    root: "sbx_1-v2",
    platformUrl: PLATFORM,
  });
  assert.deepEqual(made.opened, [{ path: dir, newWindow: true }]);
  assert.equal(made.state.remembered, undefined);
  assert.deepEqual(made.calls, ["contributions", "archive sbv_1"]);
});

test("a folder that is not empty gets the project in a new folder, or replaced files when asked", async () => {
  const parent = await scratch();
  await writeFile(join(parent, "notes.txt"), "mine");
  const inner = setup({
    choices: ["Fix the widget", "Create sbx_1-v2/"],
    folderPicks: [parent],
    answers: [ACTIONS.open],
  });
  await inner.commands.openContribution();
  const destination = join(parent, "sbx_1-v2");
  assert.equal(
    await readFile(join(destination, "package.json"), "utf8"),
    "{}\n",
  );
  assert.deepEqual(inner.opened, [{ path: destination, newWindow: false }]);
  assert.equal(inner.state.remembered, destination);
  // Again: the inner folder is now occupied, so it offers to replace.
  const again = setup({
    choices: ["Fix the widget", "Replace files in sbx_1-v2/"],
    folderPicks: [parent],
    folders: [destination],
  });
  await again.commands.openContribution();
  assert.match(again.messages.at(-1)?.text ?? "", /ready in this window/);
  assert.deepEqual(again.opened, []);
  // Or into the folder itself; dismissing the choice does nothing.
  const itself = setup({
    choices: ["Fix the widget", "Unpack into"],
    folderPicks: [parent],
    answers: [undefined],
  });
  await itself.commands.openContribution();
  assert.equal(await readFile(join(parent, "notes.txt"), "utf8"), "mine");
  assert.equal(
    await readFile(join(parent, "src", "app.ts"), "utf8"),
    "export const app = 0;\n",
  );
  assert.deepEqual(itself.opened, []);
  const dismissed = setup({
    choices: ["Fix the widget", undefined],
    folderPicks: [parent],
  });
  await dismissed.commands.openContribution();
  assert.deepEqual(dismissed.calls, ["contributions"]);
});

test("open contribution asks for sign-in, reports an empty list and refuses an unsafe archive", async () => {
  const signedOut = setup({ secrets: {}, answers: [undefined] });
  await signedOut.commands.openContribution();
  assert.deepEqual(signedOut.calls, []);
  assert.match(
    signedOut.messages[0]?.text ?? "",
    /sign in with a contributor token first/,
  );
  const none = setup({}, { contributions: [] });
  await none.commands.openContribution();
  assert.match(none.messages[0]?.text ?? "", /no contributions yet/);
  const dir = await scratch();
  const unsafe = setup(
    { choices: ["Fix the widget"], folderPicks: [dir] },
    {
      archive: zip([
        { name: "a.ts", bytes: text("a") },
        { name: "a.ts", bytes: text("b") },
      ]),
    },
  );
  await unsafe.commands.openContribution();
  assert.match(
    unsafe.messages[0]?.text ?? "",
    /unpacking the project: a\.ts: the archive holds this name twice/,
  );
  assert.deepEqual(unsafe.opened, []);
  // A closed, untitled contribution is listed for what it is; dismissing stops.
  const closed = setup(
    { choices: [undefined] },
    {
      contributions: [
        contribution({
          title: null,
          complexity: null,
          open: false,
          closesAt: null,
        }),
      ],
    },
  );
  await closed.commands.openContribution();
  assert.deepEqual(closed.offered[0]?.labels, ["Version 2"]);
  const noFolder = setup({ choices: ["Fix"], folderPicks: [undefined] });
  await noFolder.commands.openContribution();
  assert.deepEqual(noFolder.calls, ["contributions"]);
  // A token the platform no longer takes: offered a new sign-in.
  const stale = setup({ secrets: { [KEY]: "lnxc_old" }, answers: [undefined] });
  await stale.commands.openContribution();
  assert.deepEqual(stale.messages[0]?.actions, [ACTIONS.signIn]);
  assert.match(stale.messages[0]?.text ?? "", /refused your token/);
});

test("submit previews the zipped folder, confirms, sends the same bytes and follows the verdict", async () => {
  const folder = await contributionFolder({
    "src/app.ts": "export const app = 1;\n",
  });
  const passed = submission({
    id: "sbm_9",
    status: "passed",
    verdict: "passed",
    public: { passed: 2, total: 2 },
    hidden: { passed: 1, total: 1 },
  });
  const made = setup(
    {
      folders: [folder],
      choices: ["Submit 1 file"],
      answers: [ACTIONS.details],
    },
    {
      polls: [submission({ id: "sbm_9", status: "running" }), passed],
    },
  );
  await made.commands.submit();
  assert.deepEqual(made.calls, [
    "submissions sbv_1",
    "handout sbv_1",
    "preview sbv_1",
    "submit sbv_1",
    "poll sbm_9",
    "poll sbm_9",
  ]);
  const [preview, sent] = made.uploads;
  // Installed packages, the note and build output stay home.
  assert.deepEqual(preview?.names, [
    "package.json",
    "sandbox-task.json",
    "src/app.ts",
    "tests/public/spec.test.ts",
  ]);
  assert.deepEqual(sent?.bytes, preview?.bytes);
  const app = listZip(sent?.bytes ?? new Uint8Array()).find(
    (entry) => entry.name === "src/app.ts",
  );
  assert.ok(app !== undefined && sent !== undefined);
  assert.equal(
    new TextDecoder().decode(readZipEntry(sent.bytes, app, 1000)),
    "export const app = 1;\n",
  );
  assert.deepEqual(
    made.statuses.map((status) => status?.text),
    [
      "$(sync~spin) Lunox: grading…",
      "$(sync~spin) Lunox: grading…",
      "$(pass) Lunox: passed",
    ],
  );
  assert.ok(made.log.includes("  changed: src/app.ts"));
  assert.match(
    made.messages.at(-1)?.text ?? "",
    /passed \(public 2\/2 · hidden 1\/1\)/,
  );
  assert.ok(made.state.logShown >= 2);
  assert.deepEqual(made.delays, [1, 1]);
});

test("a failed first submission is retried; refused, empty and cancelled previews send nothing", async () => {
  const folder = await contributionFolder();
  const failed = submission({
    status: "failed",
    verdict: "overfit",
    failedScenarios: ["s3"],
  });
  const retry = setup(
    { folders: [folder], choices: ["Retry with 1 file"], answers: [undefined] },
    {
      submissions: [failed],
      polls: [
        submission({
          id: "sbm_9",
          status: "failed",
          verdict: "incomplete",
          retryOf: "sbm_1",
        }),
      ],
    },
  );
  await retry.commands.submit();
  assert.deepEqual(retry.calls.slice(2, 4), [
    "preview sbv_1 retry sbm_1",
    "submit sbv_1 retry sbm_1",
  ]);
  assert.equal(retry.statuses.at(-1)?.text, "$(warning) Lunox: incomplete");
  assert.equal(retry.messages.at(-1)?.level, "warn");
  const refused = setup(
    { folders: [folder], answers: [ACTIONS.details] },
    {
      preview: {
        ...changed,
        refused: [
          { path: "package.json", reason: "Revert it." },
          { path: "a.ts", reason: "x" },
          { path: "b.ts", reason: "x" },
          { path: "c.ts", reason: "x" },
        ],
      },
    },
  );
  await refused.commands.submit();
  assert.ok(!refused.calls.some((call) => call.startsWith("submit")));
  assert.match(
    refused.messages[0]?.text ?? "",
    /4 file\(s\) stop this submission: package\.json, a\.ts, b\.ts…/,
  );
  assert.ok(refused.log.includes("  package.json: Revert it."));
  const empty = setup(
    { folders: [folder] },
    { preview: { ...changed, files: [] } },
  );
  await empty.commands.submit();
  assert.match(empty.messages[0]?.text ?? "", /nothing to submit/);
  const cancelled = setup({ folders: [folder], choices: [ACTIONS.cancel] });
  await cancelled.commands.submit();
  assert.ok(!cancelled.calls.some((call) => call.startsWith("submit")));
  // Refused by the platform at the last step: said, nothing tracked.
  const late = setup(
    { folders: [folder], choices: ["Submit"] },
    {
      submitError: new ApiError(
        409,
        "You have already submitted.",
        "already_submitted",
      ),
    },
  );
  await late.commands.submit();
  assert.match(
    late.messages.at(-1)?.text ?? "",
    /Submitting: You have already submitted\. \(already_submitted\)/,
  );
  assert.deepEqual(late.statuses, []);
});

test("preview submission shows the preview and can submit from there", async () => {
  const folder = await contributionFolder();
  const made = setup(
    { folders: [folder], answers: [ACTIONS.submit, undefined] },
    { polls: [submission({ id: "sbm_9", status: "errored" })] },
  );
  await made.commands.previewSubmission();
  assert.match(made.messages[0]?.text ?? "", /1 file\(s\) would be submitted/);
  assert.ok(made.calls.includes("submit sbv_1"));
  assert.equal(
    made.statuses.at(-1)?.text,
    "$(error) Lunox: errored — Grade again",
  );
  assert.deepEqual(made.messages.at(-1)?.actions, [
    ACTIONS.gradeAgain,
    ACTIONS.details,
  ]);
  // Only previewed: nothing is sent.
  const only = setup({ folders: [folder], answers: [undefined] });
  await only.commands.previewSubmission();
  assert.ok(!only.calls.some((call) => call.startsWith("submit")));
  const blocked = setup(
    { folders: [folder] },
    { preview: { ...changed, files: [] } },
  );
  await blocked.commands.previewSubmission();
  assert.match(blocked.messages[0]?.text ?? "", /nothing to submit/);
  // Without a contribution folder open, or signed out, nothing happens.
  const none = setup({ folders: [] });
  await none.commands.previewSubmission();
  assert.match(
    none.messages[0]?.text ?? "",
    /open a contribution folder first/,
  );
  const signedOut = setup({ secrets: {}, answers: [undefined] });
  await signedOut.commands.previewSubmission();
  await signedOut.commands.submit();
  await signedOut.commands.gradeAgain();
  assert.deepEqual(signedOut.calls, []);
});

test("a folder with only its descriptor is found by its version id; another folder is not", async () => {
  const folder = await contributionFolder();
  await rm(join(folder, ".lunox"), { recursive: true });
  const made = setup({
    folders: ["/elsewhere", folder],
    files: { [join(folder, "sandbox-task.json")]: JSON.stringify(descriptor) },
    choices: [ACTIONS.cancel],
  });
  await made.commands.submit();
  assert.equal(made.calls[0], "submissions sbv_1");
  const other = setup({ folders: ["/elsewhere"] });
  await other.commands.submit();
  assert.match(other.messages[0]?.text ?? "", /no contribution here/);
  // A note from another platform is used, and the mismatch is logged.
  const moved = await contributionFolder({
    ".lunox/contribution.json": JSON.stringify({
      schemaVersion: 1,
      versionId: "sbv_1",
      root: "sbx_1-v2",
      platformUrl: "http://localhost:5173",
    }),
  });
  const mismatch = setup({ folders: [moved], choices: [ACTIONS.cancel] });
  await mismatch.commands.submit();
  assert.ok(
    mismatch.log.some((line) => line.includes("http://localhost:5173")),
  );
});

test("what to submit next is decided from the person's own submissions", async () => {
  assert.deepEqual(nextAttempt([]), { kind: "submit" });
  const first = submission({ status: "failed", verdict: "overfit" });
  assert.deepEqual(nextAttempt([first]), { kind: "retry", retryOf: "sbm_1" });
  const retry = submission({ id: "sbm_2", status: "failed", retryOf: "sbm_1" });
  assert.equal(nextAttempt([retry, first]).kind, "spent");
  assert.equal(
    nextAttempt([{ ...retry, status: "running" }, first]).kind,
    "busy",
  );
  assert.equal(nextAttempt([{ ...first, status: "errored" }]).kind, "regrade");
  assert.equal(nextAttempt([{ ...first, status: "passed" }]).kind, "passed");
  const folder = await contributionFolder();
  // Grading: said, and followed in the status bar.
  const busy = setup(
    { folders: [folder], answers: [undefined] },
    {
      submissions: [submission({ status: "running" })],
      polls: [submission({ status: "passed", verdict: "passed" })],
    },
  );
  await busy.commands.submit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(busy.messages[0]?.text ?? "", /still being graded/);
  const passed = setup(
    { folders: [folder] },
    { submissions: [submission({ status: "passed", verdict: "passed" })] },
  );
  await passed.commands.submit();
  assert.match(passed.messages[0]?.text ?? "", /nothing more to submit/);
  assert.equal(passed.statuses[0]?.text, "$(pass) Lunox: passed");
  const spent = setup({ folders: [folder] }, { submissions: [retry, first] });
  await spent.commands.submit();
  assert.match(spent.messages[0]?.text ?? "", /one retry is used/);
  // Errored: graded again on request, and followed.
  const errored = setup(
    { folders: [folder], answers: [ACTIONS.gradeAgain, undefined] },
    {
      submissions: [submission({ status: "errored" })],
      polls: [submission({ status: "passed", verdict: "passed" })],
    },
  );
  await errored.commands.submit();
  assert.ok(errored.calls.includes("regrade sbm_1"));
  assert.equal(errored.statuses.at(-1)?.text, "$(pass) Lunox: passed");
});

test("grade again, refresh and show follow the latest submission", async () => {
  const folder = await contributionFolder();
  const none = setup({ folders: [folder] }, { submissions: [] });
  await none.commands.gradeAgain();
  assert.match(
    none.messages[0]?.text ?? "",
    /no submission of yours is waiting/,
  );
  await none.commands.refreshStatus();
  assert.deepEqual(none.statuses, [undefined]);
  await none.commands.showSubmission();
  assert.equal(none.state.logShown, 0);
  // Refresh on activation: quiet, and it follows a running one.
  const running = setup(
    { folders: [folder] },
    {
      submissions: [submission({ status: "running" })],
      polls: [
        submission({
          status: "failed",
          verdict: "refused",
          refused: [{ path: "package.json", reason: "Revert it." }],
        }),
      ],
    },
  );
  await running.commands.refreshStatus();
  assert.equal(running.statuses.at(-1)?.text, "$(circle-slash) Lunox: refused");
  assert.deepEqual(running.messages, []);
  await running.commands.showSubmission();
  assert.ok(running.log.includes("  refused: package.json: Revert it."));
  assert.equal(running.state.logShown, 1);
  // The errored one it holds is graded again without asking the list.
  const errored = setup(
    { folders: [folder], answers: [undefined] },
    {
      submissions: [submission({ status: "errored" })],
      polls: [
        submission({ status: "running" }),
        submission({ status: "passed", verdict: "passed" }),
      ],
    },
  );
  await errored.commands.refreshStatus();
  await errored.commands.gradeAgain();
  assert.deepEqual(errored.calls, [
    "submissions sbv_1",
    "regrade sbm_1",
    "poll sbm_1",
    "poll sbm_1",
  ]);
  // Show with nothing held reads the latest first.
  const show = setup(
    { folders: [folder] },
    { submissions: [submission({ status: "failed", verdict: "incomplete" })] },
  );
  await show.commands.showSubmission();
  assert.ok(show.log.some((line) => line.includes("incomplete")));
  // Signed out, refresh asks nothing.
  const out = setup({ secrets: {} });
  await out.commands.refreshStatus();
  assert.deepEqual(out.calls, []);
});

test("on activation the status is restored quietly, or not at all", async () => {
  const folder = await contributionFolder();
  const restored = setup(
    { folders: [folder] },
    {
      submissions: [
        submission({
          status: "failed",
          verdict: "overfit",
          failedScenarios: ["s3"],
        }),
      ],
    },
  );
  await restored.commands.restoreStatus();
  assert.equal(restored.statuses.at(-1)?.text, "$(warning) Lunox: overfit: s3");
  assert.deepEqual(restored.messages, []);
  // No contribution open, nothing submitted, signed out or refused: silence.
  for (const quiet of [
    setup({ folders: ["/elsewhere"] }),
    setup({ folders: [folder] }, { submissions: [] }),
    setup({ folders: [folder], secrets: {} }),
    setup({ folders: [folder], secrets: { [KEY]: "lnxc_old" } }),
  ]) {
    await quiet.commands.restoreStatus();
    assert.deepEqual(quiet.messages, []);
    assert.deepEqual(quiet.statuses, []);
  }
});

test("polling stops with a refresh after its limit, or on repeated or client errors", async () => {
  const folder = await contributionFolder();
  const long = setup(
    { folders: [folder] },
    {
      submissions: [submission({ status: "running" })],
      polls: [submission({ status: "running" })],
    },
    { maxPolls: 12 },
  );
  await long.commands.refreshStatus();
  assert.equal(
    long.statuses.at(-1)?.text,
    "$(clock) Lunox: still grading — Refresh",
  );
  assert.deepEqual(long.delays, [...Array(10).fill(1), 2, 2]);
  const flaky = setup(
    { folders: [folder] },
    {
      submissions: [submission({ status: "running" })],
      polls: [
        new ApiError(503, "Unavailable."),
        new ApiError(503, "Unavailable."),
        new ApiError(503, "Unavailable."),
      ],
    },
  );
  await flaky.commands.refreshStatus();
  assert.equal(
    flaky.statuses.at(-1)?.text,
    "$(question) Lunox: status unknown — Refresh",
  );
  assert.equal(flaky.calls.filter((call) => call.startsWith("poll")).length, 3);
  const recovering = setup(
    { folders: [folder] },
    {
      submissions: [submission({ status: "running" })],
      polls: [
        new Error("socket hang up"),
        submission({ status: "passed", verdict: "passed" }),
      ],
    },
  );
  await recovering.commands.refreshStatus();
  assert.equal(recovering.statuses.at(-1)?.text, "$(pass) Lunox: passed");
  const gone = setup(
    { folders: [folder] },
    {
      submissions: [submission({ status: "running" })],
      polls: [new ApiError(404, "Not found.")],
    },
  );
  await gone.commands.refreshStatus();
  assert.match(
    gone.statuses.at(-1)?.tooltip ?? "",
    /invite may have been revoked/,
  );
  // Signing out stops a poll in flight.
  const ref: { signOut?: () => Promise<void> } = {};
  const stopped = setup(
    { folders: [folder], onDelay: () => ref.signOut?.() },
    {
      submissions: [submission({ status: "running" })],
      polls: [submission({ status: "running" })],
    },
  );
  ref.signOut = () => stopped.commands.signOut();
  await stopped.commands.refreshStatus();
  assert.equal(stopped.statuses.at(-1), undefined);
  assert.ok(!stopped.calls.some((call) => call.startsWith("poll")));
});

test("failures read as one sentence", () => {
  assert.match(failureText(new ApiError(401, "x")), /Sign in again/);
  assert.match(failureText(new ApiError(404, "x")), /revoked/);
  assert.equal(failureText(new ApiError(500, "Boom.")), "Boom.");
  assert.equal(
    failureText(new ApiError(409, "No.", "not_open")),
    "No. (not_open)",
  );
  assert.equal(failureText(new Error("plain")), "plain");
  assert.equal(failureText("text"), "text");
});
