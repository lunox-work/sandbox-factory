import { z } from "zod";
import { readPrivateKey } from "@sandbox-factory/github";
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
});
export function parseWorkerEnv(
  values: Record<string, string | undefined> = process.env,
) {
  const env = schema.parse(values);
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new Error("Object storage keys must be configured together.");
  return env;
}
