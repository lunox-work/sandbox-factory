/**
 * Environment parsing. Invalid config fails at boot with a readable message
 * rather than at the first request with a confusing one.
 */

import { unknownBuildInfo, type BuildInfoDto } from "@sandbox-factory/shared";
import { z } from "zod";

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
  // Optional: nothing in the API reads object storage yet.
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("sandbox-factory"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
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
  // Set only when the web app and the API are on different subdomains of one
  // parent (app.lunox.work, api.lunox.work), where the session cookie needs an
  // explicit Domain. Leave unset locally: a Domain on localhost breaks the
  // cookie.
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // Shared secret the CDN sends on every origin request, checked in routes.ts.
  // Unset, the check is not installed. Set in the CloudFront-to-Fargate deploy
  // in `infra/`, where the task is internet-reachable with no upstream filter.
  ORIGIN_VERIFY: z.string().optional(),

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
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/**
 * Object-storage config, or undefined unless the endpoint and both keys are
 * all set: a half-configured client would fail at the first request.
 */
export function objectStoreConfig(env: Env):
  | {
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      region: string;
    }
  | undefined {
  if (
    env.S3_ENDPOINT === undefined ||
    env.S3_ACCESS_KEY_ID === undefined ||
    env.S3_SECRET_ACCESS_KEY === undefined
  ) {
    return undefined;
  }
  return {
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
  };
}
