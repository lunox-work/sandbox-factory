/**
 * Environment parsing. Invalid config fails at boot with a readable message
 * rather than at the first request with a confusing one.
 */

import { unknownBuildInfo, type BuildInfoDto } from "@sandbox-factory/shared";
import { z } from "zod";

/**
 * An optional secret that has no value. Terraform seeds every secret with
 * `REPLACE_ME` (infra/secrets.tf) and compose passes an unset var as "", and
 * neither is a credential or a model: kept, they would configure a feature
 * that fails on its first call instead of reporting it as off.
 */
const unsetSecret = (value: unknown) =>
  value === "" || value === "REPLACE_ME" ? undefined : value;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ""),
    ),
  // Required, with no in-memory fallback: that would look healthy and lose
  // data on restart.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  /**
   * Object storage, for uploaded avatars. Off unless `S3_BUCKET` is set, and
   * the avatar routes are unmounted while it is off.
   *
   * Two shapes, one code path. Locally all four are set and point at the
   * SeaweedFS gateway. In production only the bucket is set: no endpoint means
   * AWS itself, and no keys means the SDK's default chain, which finds the ECS
   * task role. The keys are a pair — one without the other is refused below.
   *
   * `unsetSecret` for the same reason as the secrets further down: compose
   * passes an unset variable as "", which would otherwise switch storage on
   * with a bucket named nothing.
   */
  S3_ENDPOINT: z.preprocess(
    unsetSecret,
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  S3_BUCKET: z.preprocess(unsetSecret, z.string().min(1).optional()),
  S3_ACCESS_KEY_ID: z.preprocess(unsetSecret, z.string().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(unsetSecret, z.string().min(1).optional()),
  S3_REGION: z.string().default("us-east-1"),

  // ---- auth ---------------------------------------------------------------
  //
  // All required: better to not start than to fail at the first sign-in.
  //
  // Signs session tokens. Rotating it signs everyone out.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters."),
  // Public origin of the API. Provider callback URLs are built from it, so it
  // must match what is registered with each provider exactly; a mismatch
  // surfaces as a redirect_uri error at the provider, not here.
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be an absolute URL."),
  // Public origin of the web app, where a failed sign-in is redirected.
  // Defaults to the first CORS origin; see appUrl below.
  APP_URL: z.url("APP_URL must be an absolute URL.").optional(),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required."),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required."),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required."),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required."),
  // Required too: the sign-in screen offers Atlassian unconditionally, so
  // without these the button would fail at the redirect.
  ATLASSIAN_CLIENT_ID: z.string().min(1, "ATLASSIAN_CLIENT_ID is required."),
  ATLASSIAN_CLIENT_SECRET: z
    .string()
    .min(1, "ATLASSIAN_CLIENT_SECRET is required."),
  /**
   * The **second** Atlassian app, the one that connects a client's Jira site.
   * Separate from the pair above because an Atlassian grant is per app and a
   * new grant overwrites the previous one's scopes: one app serving both would
   * make signing in and connecting Jira break each other.
   *
   * Optional, unlike the sign-in credentials. Those are required because the
   * sign-in screen offers Atlassian unconditionally, so a missing value is a
   * button that fails at the redirect. Connecting Jira is a feature an
   * organization opts into, and an API with these unset should still serve
   * every other route — `jiraOAuthConfig` below returns undefined, and the
   * connect route answers 501 rather than the process refusing to boot.
   */
  JIRA_CLIENT_ID: z.preprocess(unsetSecret, z.string().min(1).optional()),
  JIRA_CLIENT_SECRET: z.preprocess(unsetSecret, z.string().min(1).optional()),
  /**
   * Encrypts the Jira tokens in `jira_connection`. `openssl rand -base64 32`.
   *
   * Required, and for a stronger reason than the rest of this block: an
   * optional key would mean the API boots without one and writes tokens the
   * cipher cannot protect. Refusing to start is the only behaviour that
   * cannot silently produce an unencrypted row.
   *
   * Rotating it is not just replacing the value — the rows encrypted under the
   * old key must be re-encrypted, which `key_id` exists to make possible.
   */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1, "TOKEN_ENCRYPTION_KEY is required.")
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).",
    ),
  // Set only when the web app and the API are on different subdomains of one
  // parent (app.lunox.work, api.lunox.work), where the session cookie needs an
  // explicit Domain. Leave unset locally: a Domain on localhost breaks the
  // cookie.
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // Shared secret the CDN sends on every origin request, checked in routes.ts.
  // Unset, the check is not installed. Set in the CloudFront-to-Fargate deploy
  // in `infra/`, where the task is internet-reachable with no upstream filter.
  ORIGIN_VERIFY: z.string().optional(),

  // Optional as a pair. Existing API features stay available without sizing.
  ANTHROPIC_API_KEY: z.preprocess(unsetSecret, z.string().min(1).optional()),
  SIZING_MODEL: z.preprocess(unsetSecret, z.string().min(1).optional()),

  // The sizing fallback, optional as its own pair. Set alongside the Anthropic
  // pair it answers whenever an Anthropic call fails; set on its own it serves
  // sizing outright. Like `SIZING_MODEL`, the model is explicit: the account
  // decides which models exist, not this application.
  DEEPSEEK_API_KEY: z.preprocess(unsetSecret, z.string().min(1).optional()),
  DEEPSEEK_SIZING_MODEL: z.preprocess(
    unsetSecret,
    z.string().min(1).optional(),
  ),
  // Override for a proxy or a self-hosted gateway. Unset, the public API.
  DEEPSEEK_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),

  // ---- build provenance ---------------------------------------------------
  //
  // Injected at image build time by `scripts/build-info.mjs`; see
  // docs/versioning.md. Deliberately optional: a reporting gap must not become
  // an outage. The release workflow enforces them instead, with
  // `build-info.mjs --require-identified`.
  BUILD_VERSION: z.string().optional(),
  BUILD_SHA: z.string().optional(),
  BUILD_TIME: z.string().optional(),
  BUILD_REF: z.string().optional(),
  BUILD_DIRTY: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Every variable the API reads. The environment is the one input to a running
 * task that the image attestation does not cover, so the list is pinned by
 * `test/env-surface.test.ts`: adding a variable is a reviewed change to what an
 * operator can alter without changing the audited image.
 */
export const envKeys: readonly string[] = Object.keys(envSchema.shape);

/**
 * Where a failed sign-in is sent: `APP_URL`, else the first CORS origin (the
 * web app in every current deploy), else the API's own origin, which is Better
 * Auth's default behaviour.
 */
export function appUrl(env: Env): string {
  return env.APP_URL ?? env.CORS_ORIGINS[0] ?? env.BETTER_AUTH_URL;
}

/**
 * The build record this process reports. Each field falls back independently,
 * so a sha without a timestamp is still reported. The short sha is derived, so
 * it cannot disagree with the full one.
 */
export function buildInfo(env: Env): BuildInfoDto {
  const sha = env.BUILD_SHA ?? unknownBuildInfo.gitSha;
  return {
    version: env.BUILD_VERSION ?? unknownBuildInfo.version,
    gitSha: sha,
    gitShortSha:
      sha === unknownBuildInfo.gitSha
        ? unknownBuildInfo.gitShortSha
        : sha.slice(0, 7),
    buildTime: env.BUILD_TIME ?? unknownBuildInfo.buildTime,
    gitRef: env.BUILD_REF ?? unknownBuildInfo.gitRef,
    dirty: env.BUILD_DIRTY,
  };
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema
    .superRefine((env, context) => {
      // Half a key pair signs every request wrongly, and the first upload is
      // a worse place to find out than boot.
      if (
        (env.S3_ACCESS_KEY_ID === undefined) !==
        (env.S3_SECRET_ACCESS_KEY === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["S3_ACCESS_KEY_ID"],
          message:
            "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both left unset to use the AWS default credential chain.",
        });
      }
    })
    .safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Credentials for the Jira connection app, or undefined unless both halves are
 * set. A half-configured pair would fail at the Atlassian redirect, which is a
 * worse place to discover it than the route that refuses to start the flow.
 */
export function jiraOAuthConfig(
  env: Env,
): { clientId: string; clientSecret: string } | undefined {
  if (
    env.JIRA_CLIENT_ID === undefined ||
    env.JIRA_CLIENT_SECRET === undefined
  ) {
    return undefined;
  }
  return {
    clientId: env.JIRA_CLIENT_ID,
    clientSecret: env.JIRA_CLIENT_SECRET,
  };
}

/** Provider config, or undefined unless both the key and explicit model exist. */
export function sizingConfig(
  env: Env,
): { apiKey: string; model: string } | undefined {
  if (env.ANTHROPIC_API_KEY === undefined || env.SIZING_MODEL === undefined) {
    return undefined;
  }
  return { apiKey: env.ANTHROPIC_API_KEY, model: env.SIZING_MODEL };
}

/**
 * Fallback provider config, on the same both-or-neither rule as the primary.
 * A key without a model is not a usable provider, and guessing a model on the
 * operator's behalf is what `SIZING_MODEL` already refuses to do.
 */
export function deepseekSizingConfig(
  env: Env,
): { apiKey: string; model: string; baseUrl?: string } | undefined {
  if (
    env.DEEPSEEK_API_KEY === undefined ||
    env.DEEPSEEK_SIZING_MODEL === undefined
  ) {
    return undefined;
  }
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_SIZING_MODEL,
    ...(env.DEEPSEEK_BASE_URL === undefined
      ? {}
      : { baseUrl: env.DEEPSEEK_BASE_URL }),
  };
}

/**
 * Whether sizing can run at all: either provider pair on its own is enough.
 * The executor is mounted on this, not on the Anthropic pair — a deploy
 * carrying only DeepSeek credentials is a configured deploy.
 */
export function sizingAvailable(env: Env): boolean {
  return (
    sizingConfig(env) !== undefined || deepseekSizingConfig(env) !== undefined
  );
}

/**
 * Object-storage config, or undefined unless a bucket is named.
 *
 * `endpoint` and `credentials` are present only when set: absent, the S3
 * client talks to AWS and resolves credentials itself (the task role in
 * production). `parseEnv` has already refused a lone key.
 */
export function objectStoreConfig(env: Env):
  | {
      bucket: string;
      region: string;
      endpoint?: string;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    }
  | undefined {
  if (env.S3_BUCKET === undefined) {
    return undefined;
  }
  return {
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
    ...(env.S3_ACCESS_KEY_ID === undefined ||
    env.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }),
  };
}
