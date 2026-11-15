/**
 * The platform's flow on one machine, from an empty database: the API's
 * HTTP routes and the worker's runs over a real Postgres, with fakes only
 * at the edges (`fakes.mjs`), composed as server.ts composes the API
 * (`compose.mjs`). `npm run test:flow`, after a build; see
 * docs/development.md. It makes a database of its own on the local
 * Postgres and drops it on the way out, passed or failed (`database.mjs`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composePlatform } from "./compose.mjs";
import { scratchDatabase } from "./database.mjs";
import {
  fakeGithub,
  fakeJira,
  graphifyExecute,
  memoryObjects,
  scriptedAgents,
  sizingCaller,
} from "./fakes.mjs";
import { PERSON, fixtureFiles, seed, sourceArchive } from "./seed.mjs";
import { JIRA_STEPS, ROUND_TRIP_STEPS } from "./roundtrip-steps.mjs";
import { PUBLISH_STEPS, USAGE_STEPS, say } from "./steps.mjs";

/** Every step, in order; a later part appends its own list. */
const STEPS = [
  ...PUBLISH_STEPS,
  ...ROUND_TRIP_STEPS,
  ...JIRA_STEPS,
  ...USAGE_STEPS,
];
/**
 * npm's cache for the worker's jobs and the contributor's machine, kept
 * between runs so an install reads the registry once; content-addressed,
 * and checked against each lockfile's integrity, so a shared one is safe.
 */
const npmCache = join(tmpdir(), "sandbox-factory-flow-npm-cache");

const started = performance.now();
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 250);
let failed = false;
let database;
let platform;
let scratch;
try {
  database = await scratchDatabase();
  say(`database ${database.name}`);
  // Interrupted, the scratch goes too; `finally` never runs on a signal.
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void database
        .drop()
        .catch(() => {})
        .finally(() => process.exit(130));
    });
  scratch = await mkdtemp(join(tmpdir(), "sandbox-factory-flow-steps-"));
  const { files, commitSha } = await fixtureFiles();
  const github = fakeGithub({ files, commitSha });
  const agents = scriptedAgents();
  const caller = sizingCaller();
  const jira = fakeJira();
  platform = await composePlatform({
    databaseUrl: database.url,
    objects: memoryObjects(),
    caller,
    agentModel: agents,
    github,
    graphify: graphifyExecute(),
    jira,
    npmCache,
    log: say,
  });
  const archive = await sourceArchive(commitSha);
  const seeded = await seed(platform, { commitSha, archive });
  say(
    `seeded ${seeded.organizationId}, ${seeded.repoId} at ${commitSha.slice(0, 7)}`,
  );
  const flow = {
    platform,
    github,
    agents,
    caller,
    jira,
    fixture: files,
    commitSha,
    scratch,
    npmCache,
    userId: PERSON.id,
    ...seeded,
  };
  for (const [name, step] of STEPS) {
    const at = performance.now();
    await step(flow);
    say(`ok ${name} (${Math.round(performance.now() - at)} ms)`);
  }
} catch (error) {
  failed = true;
  console.error(error);
  if (platform !== undefined)
    console.error(
      `runs: ${platform.ranRuns.map((run) => `${run.tool}:${run.status}${run.errorCode ? `(${run.errorCode})` : ""}`).join(" ") || "none"}`,
    );
} finally {
  await platform?.close().catch((error) => console.error(error));
  if (scratch !== undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  await database?.drop().catch((error) => {
    failed = true;
    console.error(`could not drop ${database.name}:`, error);
  });
  clearInterval(sampler);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  say(
    `${failed ? "FAILED" : "passed"} in ${((performance.now() - started) / 1000).toFixed(1)} s, peak RSS ${Math.round(peakRss / 1024 / 1024)} MB (this process; npm and tsc jobs run apart)`,
  );
}
process.exitCode = failed ? 1 : 0;
