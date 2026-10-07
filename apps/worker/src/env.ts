import { z } from "zod";
import { readPrivateKey } from "@sandbox-factory/github";
import { AGENT_LIMITS_DEFAULT } from "./agent/loop.js";
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
  /**
   * The DeepWiki-Open service the deepwiki builder asks for a wiki. Optional:
   * without a URL deepwiki runs fail with `builder_unavailable`. The
   * repository read token is sent to it, so it must be a trusted deployment.
   * The provider and model are passed through only when set; the service
   * applies its own defaults otherwise.
   */
  DEEPWIKI_OPEN_URL: z.preprocess(blank, z.url().optional()),
  DEEPWIKI_OPEN_AUTH_CODE: z.preprocess(
    unsetSecret,
    z.string().min(1).optional(),
  ),
  DEEPWIKI_OPEN_PROVIDER: z.preprocess(blank, z.string().min(1).optional()),
  DEEPWIKI_OPEN_MODEL: z.preprocess(blank, z.string().min(1).optional()),
});
export function parseWorkerEnv(
  values: Record<string, string | undefined> = process.env,
) {
  const env = schema.parse(values);
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new Error("Object storage keys must be configured together.");
  if (env.ANTHROPIC_API_KEY !== undefined && env.AGENT_MODEL === undefined)
    throw new Error("AGENT_MODEL must be set with ANTHROPIC_API_KEY.");
  return env;
}
