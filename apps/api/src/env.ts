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
