/**
 * Environment parsing. Invalid config fails at boot with a readable message
 * rather than at the first request with a confusing one.
 */

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
  // from this, so it has to match what is registered with Google and GitHub
  // exactly — a trailing slash or a wrong scheme produces a redirect_uri
  // mismatch at the provider, not an error here.
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be an absolute URL."),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required."),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required."),
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required."),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required."),
  // Set only when the web app and the API sit on different subdomains of one
  // parent (app.lunox.work and api.lunox.work), where the session cookie needs
  // an explicit Domain to be sent at all. Unset for same-origin local dev:
  // a Domain attribute on localhost stops the cookie working entirely.
  AUTH_COOKIE_DOMAIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

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
