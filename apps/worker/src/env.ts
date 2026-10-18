import { z } from "zod";
import { readPrivateKey } from "@sandbox-factory/github";
import { AGENT_LIMITS_DEFAULT } from "./agent/loop.js";
import { JOB_UID_MIN } from "./evaluation/isolation.js";
const blank = (value: unknown) => (value === "" ? undefined : value);
/** An unset secret: empty, or the placeholder the deploy's secrets start as. */
const unsetSecret = (value: unknown) =>
  value === "" || value === "REPLACE_ME" ? undefined : value;
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
  ),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).transform(readPrivateKey),
  WORKER_MODE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["once", "poll"]).default("once"),
  ),
  /**
   * In `poll` mode, the minutes without a run after which the worker exits:
   * a task launched for a burst stays warm for the next one, then goes.
   * Unset, a polling worker runs until stopped, as Compose's does.
   */
  WORKER_IDLE_EXIT_MINUTES: z.preprocess(
    blank,
    z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .optional(),
  ),
  MAX_TARBALL_BYTES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(200 * 1024 * 1024),
  ),
  MAX_FILES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().positive().max(100_000).default(20_000),
  ),
  /**
   * Where sandbox builds run their baseline. `local-process` is a
   * development provider, not an isolation boundary, so it is opt-in; with
   * `none` a build fails with `evaluation_failed`.
   */
  EVALUATION_PROVIDER: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["none", "local-process"]).default("none"),
  ),
  /**
   * The first of the uids a root worker runs `local-process` jobs as, one
   * per concurrent job, gid the same number (`evaluation/isolation.ts`).
   * They need no passwd entry, and nothing else may run as them: after a
   * job, every process of its uid is killed. At least `JOB_UID_MIN`, above
   * the uids people and services get (`node` is 1000), and so never root,
   * the only worker that switches to them.
   */
  EVALUATION_JOB_UID: z.preprocess(
    blank,
    z.coerce.number().int().min(JOB_UID_MIN).max(2_000_000_000).default(61_000),
  ),
  /**
   * The model behind the scope and fixtures agents. Without a key, agent
   * runs fail with `agent_unavailable`; with one, the model must be named.
   * Like the API's `SIZING_MODEL`, the model is explicit: deployment config
   * names it, so a model alone (no key) is allowed and does nothing.
   */
  ANTHROPIC_API_KEY: z.preprocess(unsetSecret, z.string().min(1).optional()),
  AGENT_MODEL: z.preprocess(blank, z.string().min(1).optional()),
  /**
   * Every token one agent run may spend, cached or not. The defaults are
   * the loop's own, so a worker without these set runs as tests assume.
   */
  AGENT_TOKEN_BUDGET: z.preprocess(
    blank,
    z.coerce
      .number()
      .int()
      .positive()
      .max(50_000_000)
      .default(AGENT_LIMITS_DEFAULT.maxTokens),
  ),
  AGENT_MAX_TURNS: z.preprocess(
    blank,
    z.coerce
      .number()
      .int()
      .positive()
      .max(200)
      .default(AGENT_LIMITS_DEFAULT.maxTurns),
  ),
});
export function parseWorkerEnv(
  values: Record<string, string | undefined> = process.env,
) {
  const env = schema.parse(values);
  // Contributor code needs an isolation boundary, which local processes
  // are not; a production worker refuses to start rather than run it so.
  if (
    env.EVALUATION_PROVIDER === "local-process" &&
    values["NODE_ENV"] === "production"
  )
    throw new Error(
      "EVALUATION_PROVIDER=local-process is a development provider, not an isolation boundary; it is refused with NODE_ENV=production.",
    );
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new Error("Object storage keys must be configured together.");
  if (env.ANTHROPIC_API_KEY !== undefined && env.AGENT_MODEL === undefined)
    throw new Error("AGENT_MODEL must be set with ANTHROPIC_API_KEY.");
  return env;
}
