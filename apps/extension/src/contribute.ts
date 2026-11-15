/**
 * An invited contributor's flow in the editor: sign in with a contributor
 * token, open a contribution (download its archive, unpack it into a
 * folder, open it), preview and submit the folder, and follow the verdict
 * in the status bar.
 *
 * The token (`lnxc_…`, made on the web's Contributions page) is checked
 * against the platform before it is kept, and kept in `SecretStorage`
 * under the platform's origin, never in settings or on disk; the folder's
 * `.lunox/contribution.json` names the version only. A submission is the
 * folder zipped (`workspace.ts`) and sent to the zip route the web page
 * uses: `?dryRun=1` first, whose answer (files to submit, files left out,
 * refusals with reasons) is shown before the person confirms, then the
 * same bytes for real. Which route is decided from the person's own
 * submissions: a first submission, the one retry of a failed one, or
 * "Grade again" for one that could not be graded. The API decides
 * everything again; the choice here only picks the right request.
 */

import { basename, join } from "node:path";

import type { ContributorClient } from "@sandbox-factory/client";
import { ApiError } from "@sandbox-factory/client";
import {
  SUBMISSION_ZIP_MAX_BYTES,
  type ContributionDto,
  type ContributionSubmissionDto,
  type FolderPreviewDto,
} from "@sandbox-factory/shared";
import { TASK_DESCRIPTOR_PATH } from "sandbox-factory";

import type { Choice, Host } from "./host.js";
import { tokenProblem, tokensPageUrl } from "./origin.js";
import {
  describeSubmission,
  isSettled,
  previewLines,
  statusOf,
} from "./status.js";
import { parseDescriptor } from "./task.js";
import {
  collectFolder,
  folderState,
  readNote,
  unpackArchive,
  writeNote,
} from "./workspace.js";
import { zip } from "./zip.js";

/** The contributor routes the commands call; `ContributorClient` in the extension. */
export type ContributorApi = Pick<
  ContributorClient,
  | "contributions"
  | "contributionArchive"
  | "contributionHandout"
  | "contributionSubmissions"
  | "contributionSubmission"
  | "previewContributionFolder"
  | "submitContributionFolder"
  | "regradeContribution"
>;

export interface ContributeOptions {
  readonly host: Host;
  /** The platform's origin, from user settings (`origin.ts`). */
  readonly platformUrl: string;
  /** Where the token is kept in `SecretStorage`, bound to that origin. */
  readonly tokenKey: string;
  /** A client sending whatever `getToken` answers as its bearer. */
  readonly connect: (
    getToken: () => PromiseLike<string | null>,
  ) => ContributorApi;
  /** How often grading is polled: first, then after `settleAfter` polls. */
  readonly pollMs?: { readonly first: number; readonly then: number };
  /** Polls before the status bar stops and offers a refresh. */
  readonly maxPolls?: number;
}

export interface ContributeCommands {
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  openContribution(): Promise<void>;
  previewSubmission(): Promise<void>;
  submit(): Promise<void>;
  gradeAgain(): Promise<void>;
  /** The latest submission's status, polled until it settles. */
  refreshStatus(): Promise<void>;
  /**
   * On activation: the open contribution's latest status, quietly. No
   * contribution folder, no sign-in or a failed request shows nothing.
   */
  restoreStatus(): Promise<void>;
  /** The latest submission in full, in the log. */
  showSubmission(): Promise<void>;
}

/** Labels of the buttons the commands offer, for the tests. */
export const ACTIONS = {
  signIn: "Sign in",
  pasteToken: "Paste a token",
  makeToken: "Make a token on the web",
  open: "Open",
  openNewWindow: "Open in new window",
  submit: "Submit",
  details: "Show details",
  gradeAgain: "Grade again",
  cancel: "Cancel",
} as const;

/** Where the folder lives, and which version it is. */
interface Located {
  readonly folder: string;
  readonly versionId: string;
}

/** What submitting now would be, from the person's own submissions. */
type Attempt =
  | { readonly kind: "submit" }
  | { readonly kind: "retry"; readonly retryOf: string }
  | Waiting<"busy">
  | Waiting<"regrade">
  | Waiting<"passed">
  | Waiting<"spent">;
/** No new submission now: the one that stands, and why. */
interface Waiting<Kind extends string> {
  readonly kind: Kind;
  readonly submission: ContributionSubmissionDto;
}

/**
 * The attempt the next submission is: the first; the one retry of a failed
 * first; or none (grading, passed, retry spent), or grading again when the
 * last could not be graded. Newest first, as the API lists them.
 */
export function nextAttempt(
  submissions: readonly ContributionSubmissionDto[],
): Attempt {
  const first = submissions.find((each) => each.retryOf === null);
  if (first === undefined) return { kind: "submit" };
  const retry = submissions.find((each) => each.retryOf === first.id);
  const latest = retry ?? first;
  if (!isSettled(latest)) return { kind: "busy", submission: latest };
  if (latest.status === "errored")
    return { kind: "regrade", submission: latest };
  if (latest.status === "passed") return { kind: "passed", submission: latest };
  if (retry !== undefined) return { kind: "spent", submission: retry };
  return { kind: "retry", retryOf: first.id };
}

/** An API failure as one sentence; a 401 means signing in again. */
export function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isUnauthorized)
      return "The platform refused your token: it was revoked, expired or made for another address. Sign in again.";
    if (error.isNotFound)
      return "The platform does not know that contribution for you: the invite may have been revoked.";
    return error.code === null
      ? error.message
      : `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createContributeCommands(
  options: ContributeOptions,
): ContributeCommands {
  const { host, platformUrl, tokenKey } = options;
  const poll = options.pollMs ?? { first: 3_000, then: 10_000 };
  const maxPolls = options.maxPolls ?? 360;
  const api = options.connect(() =>
    host.getSecret(tokenKey).then((token) => token ?? null),
  );
  /** Bumped by every new track, so an older poll stops. */
  let tracking = 0;
  let latest: {
    versionId: string;
    submission: ContributionSubmissionDto;
  } | null = null;

  const signedIn = async () => (await host.getSecret(tokenKey)) !== undefined;

  /** Runs an API step, reporting failure; undefined when it failed. */
  async function attempt<T>(
    what: string,
    step: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      const text = failureText(error);
      host.log(`${what}: ${text}`);
      if (error instanceof ApiError && error.isUnauthorized) {
        const choice = await host.ask("error", `Lunox: ${text}`, [
          ACTIONS.signIn,
        ]);
        if (choice === ACTIONS.signIn) await commands.signIn();
      } else host.error(`Lunox: ${what}: ${text}`);
      return undefined;
    }
  }

  async function requireSignIn(): Promise<boolean> {
    if (await signedIn()) return true;
    const choice = await host.ask(
      "info",
      "Lunox: sign in with a contributor token first.",
      [ACTIONS.signIn],
    );
    return choice === ACTIONS.signIn && (await commands.signIn());
  }

  /** The open folder that is a contribution: its note, else its descriptor. */
  async function locate(quiet = false): Promise<Located | null> {
    const folders = host.workspaceFolders();
    for (const folder of folders) {
      const note = await readNote(folder);
      if (note !== null) {
        if (note.platformUrl !== platformUrl)
          host.log(
            `${folder} was downloaded from ${note.platformUrl}; this window talks to ${platformUrl} (sandboxFactory.platformUrl).`,
          );
        return { folder, versionId: note.versionId };
      }
      const descriptor = parseDescriptor(
        await host.readFile(join(folder, TASK_DESCRIPTOR_PATH)),
      );
      if (descriptor.ok)
        return { folder, versionId: descriptor.descriptor.versionId };
    }
    if (quiet) return null;
    host.error(
      folders.length === 0
        ? "Lunox: open a contribution folder first (Lunox: Open contribution)."
        : `Lunox: no contribution here: neither .lunox/contribution.json nor ${TASK_DESCRIPTOR_PATH} in the open folder.`,
    );
    return null;
  }

  /** Follows a submission in the status bar until it settles. */
  async function track(
    versionId: string,
    submission: ContributionSubmissionDto,
    announce: boolean,
  ): Promise<void> {
    const mine = ++tracking;
    let current = submission;
    let polls = 0;
    let failures = 0;
    for (;;) {
      latest = { versionId, submission: current };
      host.setStatus(statusOf(current));
      if (isSettled(current)) {
        const line = describeSubmission(current);
        host.log(line);
        if (announce) {
          const level =
            current.verdict === "passed"
              ? "info"
              : current.status === "errored"
                ? "error"
                : "warn";
          const choice = await host.ask(
            level,
            `Lunox: ${line}`,
            current.status === "errored"
              ? [ACTIONS.gradeAgain, ACTIONS.details]
              : [ACTIONS.details],
          );
          if (choice === ACTIONS.gradeAgain) await commands.gradeAgain();
          else if (choice === ACTIONS.details) host.showLog();
        }
        return;
      }
      if (polls >= maxPolls) {
        host.setStatus({
          text: "$(clock) Lunox: still grading — Refresh",
          tooltip: `${describeSubmission(current)} Click to check again.`,
          command: "refreshStatus",
        });
        return;
      }
      await host.delay(polls < 10 ? poll.first : poll.then);
      polls += 1;
      if (mine !== tracking) return;
      try {
        current = await api.contributionSubmission(versionId, current.id);
        failures = 0;
      } catch (error) {
        failures += 1;
        host.log(`Checking ${current.id}: ${failureText(error)}`);
        if (
          failures >= 3 ||
          (error instanceof ApiError && error.status < 500)
        ) {
          host.setStatus({
            text: "$(question) Lunox: status unknown — Refresh",
            tooltip: failureText(error),
            command: "refreshStatus",
          });
          return;
        }
      }
      if (mine !== tracking) return;
    }
  }

  /** The folder zipped and previewed, with what submitting it would be. */
  async function prepare(located: Located): Promise<
    | {
        readonly attempt: Extract<Attempt, { kind: "submit" | "retry" }>;
        readonly folder: Blob;
        readonly preview: FolderPreviewDto;
      }
    | undefined
  > {
    const { versionId, folder } = located;
    const submissions = await attempt("Reading your submissions", () =>
      api.contributionSubmissions(versionId),
    );
    if (submissions === undefined) return undefined;
    const next = nextAttempt(submissions);
    if (next.kind === "busy") {
      host.info("Lunox: your submission is still being graded.");
      void track(versionId, next.submission, true);
      return undefined;
    }
    if (next.kind === "regrade") {
      const choice = await host.ask(
        "warn",
        `Lunox: ${describeSubmission(next.submission)}`,
        [ACTIONS.gradeAgain],
      );
      if (choice === ACTIONS.gradeAgain) await commands.gradeAgain();
      return undefined;
    }
    if (next.kind === "passed") {
      host.setStatus(statusOf(next.submission));
      host.info(
        "Lunox: your submission passed; there is nothing more to submit.",
      );
      return undefined;
    }
    if (next.kind === "spent") {
      host.setStatus(statusOf(next.submission));
      host.warn(
        "Lunox: your one retry is used: this version takes no more submissions from you.",
      );
      return undefined;
    }
    const sending = next;
    return host.progress("Lunox: checking the folder…", async () => {
      const handout = await attempt("Reading the version's files", () =>
        api.contributionHandout(versionId),
      );
      if (handout === undefined) return undefined;
      let collected;
      try {
        collected = await collectFolder(
          folder,
          new Set(handout.files.map((file) => file.path)),
        );
      } catch (error) {
        host.error(`Lunox: reading the folder: ${failureText(error)}`);
        return undefined;
      }
      for (const link of collected.links)
        host.log(`Not uploaded: ${link} is a symbolic link.`);
      const bytes = zip(collected.entries);
      if (bytes.byteLength > SUBMISSION_ZIP_MAX_BYTES) {
        host.error(
          `Lunox: the folder zips to ${bytes.byteLength} bytes; a submission is at most ${SUBMISSION_ZIP_MAX_BYTES}.`,
        );
        return undefined;
      }
      const zipped = new Blob([bytes], { type: "application/zip" });
      const retryOf = sending.kind === "retry" ? sending.retryOf : undefined;
      const preview = await attempt("Previewing the submission", () =>
        api.previewContributionFolder(versionId, zipped, retryOf),
      );
      if (preview === undefined) return undefined;
      host.log(
        `${sending.kind === "retry" ? "Retry" : "Submission"} preview for ${versionId} from ${folder} (${collected.entries.length} file(s) uploaded, ${collected.skipped} left out locally):`,
      );
      for (const line of previewLines(preview)) host.log(line);
      return { attempt: sending, folder: zipped, preview };
    });
  }

  /** Why a preview cannot be submitted, shown with its details; null when it can. */
  async function blocked(preview: FolderPreviewDto): Promise<boolean> {
    if (preview.refused.length > 0) {
      const choice = await host.ask(
        "error",
        `Lunox: ${preview.refused.length} file(s) stop this submission: ${preview.refused
          .slice(0, 3)
          .map((each) => each.path)
          .join(", ")}${preview.refused.length > 3 ? "…" : ""}.`,
        [ACTIONS.details],
      );
      if (choice === ACTIONS.details) host.showLog();
      return true;
    }
    if (preview.files.length === 0) {
      host.warn(
        "Lunox: nothing to submit: no task file differs from the version.",
      );
      return true;
    }
    return false;
  }

  async function send(
    located: Located,
    prepared: NonNullable<Awaited<ReturnType<typeof prepare>>>,
  ): Promise<void> {
    const { versionId } = located;
    const retryOf =
      prepared.attempt.kind === "retry" ? prepared.attempt.retryOf : undefined;
    const made = await attempt(
      retryOf === undefined ? "Submitting" : "Retrying",
      () =>
        host.progress("Lunox: submitting…", () =>
          api.submitContributionFolder(versionId, prepared.folder, retryOf),
        ),
    );
    if (made === undefined) return;
    host.log(
      `Submitted ${made.id}${retryOf === undefined ? "" : ` (retry of ${retryOf})`}.`,
    );
    await track(versionId, made, true);
  }

  const commands: ContributeCommands = {
    async signIn() {
      const how = await host.choose<"paste" | "make">(
        [
          {
            label: ACTIONS.pasteToken,
            detail: `A contributor token (lnxc_…) for ${platformUrl}.`,
            value: "paste",
          },
          {
            label: ACTIONS.makeToken,
            detail: `Opens ${tokensPageUrl(platformUrl)}: make one under Tokens for your editor or agent, then paste it here.`,
            value: "make",
          },
        ],
        "Sign in to Lunox with a contributor token",
      );
      if (how === undefined) return false;
      if (how === "make") await host.openExternal(tokensPageUrl(platformUrl));
      const raw = await host.input(
        `Paste a contributor token for ${platformUrl}`,
        "lnxc_…",
        { password: true },
      );
      const token = raw?.trim();
      if (token === undefined || token === "") return false;
      const problem = tokenProblem(token);
      if (problem !== null) {
        host.error(`Lunox: ${problem}`);
        return false;
      }
      let contributions: ContributionDto[];
      try {
        contributions = await options
          .connect(() => Promise.resolve(token))
          .contributions();
      } catch (error) {
        host.error(`Lunox: not signed in: ${failureText(error)}`);
        return false;
      }
      await host.storeSecret(tokenKey, token);
      host.log(`Signed in to ${platformUrl}.`);
      host.info(
        `Lunox: signed in to ${platformUrl}: ${contributions.length} contribution(s).`,
      );
      return true;
    },

    async signOut() {
      tracking += 1;
      latest = null;
      await host.deleteSecret(tokenKey);
      host.setStatus(undefined);
      host.info(
        `Lunox: signed out of ${platformUrl}. The token itself still works until you revoke it on your Contributions page.`,
      );
    },

    async openContribution() {
      if (!(await requireSignIn())) return;
      const list = await attempt("Listing your contributions", () =>
        api.contributions(),
      );
      if (list === undefined) return;
      if (list.length === 0) {
        host.info(
          "Lunox: you have no contributions yet. Open the invite link you were sent and claim it first.",
        );
        return;
      }
      const choices: Choice<ContributionDto>[] = list.map((each) => ({
        label: each.title ?? `Version ${each.version}`,
        description: [`v${each.version}`, each.complexity]
          .filter((part) => part !== null)
          .join(" · "),
        detail: each.open
          ? `Takes submissions${each.closesAt === null ? "" : ` until ${each.closesAt.slice(0, 10)}`} · ${each.editablePaths.length} editable file(s)`
          : "Closed: it takes no submissions now",
        value: each,
      }));
      const chosen = await host.choose(choices, "Open which contribution?");
      if (chosen === undefined) return;
      const picked = await host.pickFolder(
        `Choose a folder for ${chosen.root}`,
      );
      if (picked === undefined) return;
      const destination = await chooseDestination(picked, chosen.root);
      if (destination === undefined) return;
      const unpacked = await host.progress(
        `Lunox: downloading ${chosen.root}…`,
        async () => {
          const archive = await attempt("Downloading the project", () =>
            api.contributionArchive(chosen.versionId),
          );
          if (archive === undefined) return undefined;
          try {
            const result = await unpackArchive(
              new Uint8Array(await archive.blob.arrayBuffer()),
              destination,
            );
            await writeNote(destination, {
              schemaVersion: 1,
              versionId: chosen.versionId,
              root: chosen.root,
              platformUrl,
            });
            return result;
          } catch (error) {
            host.error(`Lunox: unpacking the project: ${failureText(error)}`);
            return undefined;
          }
        },
      );
      if (unpacked === undefined) return;
      host.log(
        `Unpacked ${unpacked.files} file(s) of ${chosen.versionId} into ${destination}.`,
      );
      if (host.workspaceFolders().includes(destination)) {
        host.info(`Lunox: ${chosen.root} is ready in this window.`);
        return;
      }
      const how = await host.ask(
        "info",
        `Lunox: ${chosen.root} is ready in ${destination}. Run npm ci, then npm test.`,
        [ACTIONS.open, ACTIONS.openNewWindow],
      );
      if (how === undefined) return;
      const newWindow = how === ACTIONS.openNewWindow;
      if (!newWindow) await host.rememberOpened(destination);
      await host.openFolder(destination, newWindow);
    },

    async previewSubmission() {
      if (!(await requireSignIn())) return;
      const located = await locate();
      if (located === null) return;
      const prepared = await prepare(located);
      if (prepared === undefined) return;
      host.showLog();
      if (await blocked(prepared.preview)) return;
      const choice = await host.ask(
        "info",
        `Lunox: ${prepared.preview.files.length} file(s) would be ${prepared.attempt.kind === "retry" ? "sent as your one retry" : "submitted"}.`,
        [ACTIONS.submit],
      );
      if (choice === ACTIONS.submit) await send(located, prepared);
    },

    async submit() {
      if (!(await requireSignIn())) return;
      const located = await locate();
      if (located === null) return;
      const prepared = await prepare(located);
      if (prepared === undefined) return;
      host.showLog();
      if (await blocked(prepared.preview)) return;
      const { files } = prepared.preview;
      const retry = prepared.attempt.kind === "retry";
      const confirmed = await host.choose<boolean>(
        [
          {
            label: retry
              ? `Retry with ${files.length} file(s)`
              : `Submit ${files.length} file(s)`,
            description: retry
              ? "your one retry"
              : "one first submission, one retry",
            detail: files.map((file) => file.path).join(", "),
            value: true,
          },
          { label: ACTIONS.cancel, value: false },
        ],
        retry
          ? "Send this folder as the retry of your failed submission?"
          : "Submit this folder for grading?",
      );
      if (confirmed !== true) return;
      await send(located, prepared);
    },

    async gradeAgain() {
      if (!(await requireSignIn())) return;
      let target = latest;
      if (target === null || target.submission.status !== "errored") {
        const located = await locate();
        if (located === null) return;
        const submissions = await attempt("Reading your submissions", () =>
          api.contributionSubmissions(located.versionId),
        );
        if (submissions === undefined) return;
        const errored = submissions.find((each) => each.status === "errored");
        if (errored === undefined) {
          host.info(
            "Lunox: no submission of yours is waiting to be graded again.",
          );
          return;
        }
        target = { versionId: located.versionId, submission: errored };
      }
      const { versionId, submission } = target;
      const regraded = await attempt("Grading again", () =>
        api.regradeContribution(versionId, submission.id),
      );
      if (regraded === undefined) return;
      host.log(`Grading ${regraded.id} again.`);
      await track(versionId, regraded, true);
    },

    async refreshStatus() {
      if (!(await signedIn())) return;
      const located = await locate();
      if (located === null) return;
      const submissions = await attempt("Reading your submissions", () =>
        api.contributionSubmissions(located.versionId),
      );
      const newest = submissions?.[0];
      if (newest === undefined) {
        host.setStatus(undefined);
        return;
      }
      await track(located.versionId, newest, false);
    },

    async restoreStatus() {
      if (!(await signedIn())) return;
      const located = await locate(true);
      if (located === null) return;
      let submissions: readonly ContributionSubmissionDto[];
      try {
        submissions = await api.contributionSubmissions(located.versionId);
      } catch (error) {
        host.log(`Reading your submissions: ${failureText(error)}`);
        return;
      }
      const newest = submissions[0];
      if (newest !== undefined) await track(located.versionId, newest, false);
    },

    async showSubmission() {
      if (latest === null) {
        await commands.refreshStatus();
        if (latest === null) return;
      }
      const { submission } = latest;
      host.log(describeSubmission(submission));
      for (const each of submission.refused)
        host.log(`  refused: ${each.path}: ${each.reason}`);
      host.showLog();
    },
  };

  /**
   * Where to unpack: the folder picked when it is empty; when it is not,
   * a new folder named for the contribution inside it, or the folder
   * itself with files of the same names replaced, as the person says.
   */
  async function chooseDestination(
    picked: string,
    root: string,
  ): Promise<string | undefined> {
    if ((await folderState(picked)) !== "occupied") return picked;
    const inner = join(picked, root);
    const innerState = await folderState(inner);
    return host.choose<string>(
      [
        innerState === "occupied"
          ? {
              label: `Replace files in ${root}/ inside it`,
              detail: `${inner} is not empty: files with the same names are overwritten, others are kept.`,
              value: inner,
            }
          : {
              label: `Create ${root}/ inside it`,
              detail: inner,
              value: inner,
            },
        {
          label: `Unpack into ${basename(picked)} itself`,
          detail: `${picked} is not empty: files with the same names are overwritten, others are kept.`,
          value: picked,
        },
      ],
      `${basename(picked)} is not empty`,
    );
  }

  return commands;
}
