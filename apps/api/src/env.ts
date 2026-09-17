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
  // Required, with no in-memory fallback: a server that silently keeps todos
  // in a process that is about to restart looks healthy and loses data. If
  // the database is not configured, that is a boot failure worth seeing.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required."),
  // Off unless a url is set. Object storage has no consumer in the API yet,
  // so requiring it would block boot on a dependency nothing reads.
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("sandbox-factory"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),

  // ---- auth ---------------------------------------------------------------
  //
  // Required, like DATABASE_URL and for the same reason: an API that boots
  // without a signing secret or without its OAuth clients looks healthy and
  // then fails at the one moment a user tries to sign in. Better to not start.
  //
  // BETTER_AUTH_SECRET signs session tokens. Rotating it invalidates every
  // existing session, which is the intended way to sign everyone out.
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters."),
  // Public origin of the API. Better Auth builds the provider callback URLs
  // from this, so it has to match what is registered with Google, GitHub and
  // Atlassian exactly — a trailing slash or a wrong scheme produces a redirect_uri
  // mismatch at the provider, not an error here.
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be an absolute URL."),
  // Public origin of the web app. A failed sign-in is redirected here, so that
  // the error appears in the app rather than on the API's own error page,
  // whose "Go Home" link points back at the API and strands the user.
  //
  // Defaults to the first CORS origin, which is the web app in every current
  // deploy shape; set it explicitly when that is not true.
  APP_URL: z.url("APP_URL must be an absolute URL.").optional(),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required."),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required."),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required."),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required."),
  // Required alongside the other two. Atlassian is offered on the sign-in
  // screen unconditionally, so a deployment missing these would render a
  // button that fails at the redirect rather than one that is simply absent.
  ATLASSIAN_CLIENT_ID: z.string().min(1, "ATLASSIAN_CLIENT_ID is required."),
  ATLASSIAN_CLIENT_SECRET: z
    .string()
    .min(1, "ATLASSIAN_CLIENT_SECRET is required."),
  // Set only when the web app and the API sit on different subdomains of one
  // parent (app.lunox.work and api.lunox.work), where the session cookie needs
  // an explicit Domain to be sent at all. Unset for same-origin local dev:
  // a Domain attribute on localhost stops the cookie working entirely.
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // ---- build provenance ---------------------------------------------------
  //
  // Injected at image build time by `scripts/build-info.mjs`; see
  // docs/versioning.md.
  //
  // All optional, which is the opposite of the rule the secrets above follow,
  // and deliberately so. A missing DATABASE_URL means the server cannot do its
  // job; a missing BUILD_SHA means it cannot say which commit it is — real, but
  // cosmetic, and refusing to boot over it would turn a reporting gap into an
  // outage. The guard belongs earlier, at the point of building a release
  // artifact, where it fails a pipeline instead of a deployment: the release
  // workflow runs `build-info.mjs --require-identified` for exactly that.
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
 * Where a failed sign-in is sent.
 *
 * `APP_URL` when set, else the first CORS origin — the web app in every
 * current deploy shape. Falls back to the API's own origin only when nothing
 * else is configured, which restores Better Auth's default behaviour rather
 * than crashing over a cosmetic redirect.
 */
export function appUrl(env: Env): string {
  return env.APP_URL ?? env.CORS_ORIGINS[0] ?? env.BETTER_AUTH_URL;
}

/**
 * The build record this process reports, assembled from the environment.
 *
 * Each field falls back independently rather than the record falling back as a
 * whole: a build that recorded a sha but no timestamp should still report the
 * sha, since the sha is the field that identifies it.
 *
 * The short sha is derived here rather than injected, so it cannot disagree
 * with the full one it is supposed to abbreviate.
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
 * Object-storage config, or undefined when it is not configured.
 *
 * All three secrets must be present together — a half-configured client fails
 * at the first request with an auth error rather than at boot.
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
