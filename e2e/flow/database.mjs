/**
 * The flow's own database: created on the Postgres `DATABASE_URL` names,
 * migrated with packages/db's migrator, and dropped when the run ends,
 * passed or failed. `DATABASE_URL` is only the server and the admin
 * credentials; the database it names is never written. A host other than
 * this machine's or a CI service's is refused, and so is a scratch name
 * that is not this harness's, so no run can reach a shared database.
 */

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { runMigrations } from "@sandbox-factory/db";

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/postgres";
/** Loopback, and the service names CI's Postgres containers answer to. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "postgres",
]);
const SCRATCH = /^sandbox_factory_flow_\d+$/;
const migrationsFolder = fileURLToPath(
  new URL("../../packages/db/drizzle/", import.meta.url),
);

/**
 * The server's maintenance database, refused unless the server is local.
 * Admin statements run there, never in the database the URL names.
 */
export function adminUrl(env = process.env) {
  const url = new URL(env.DATABASE_URL ?? DEFAULT_URL);
  if (!LOCAL_HOSTS.has(url.hostname))
    throw new Error(
      `test:flow creates and drops databases, so it runs only against a local Postgres; DATABASE_URL names ${url.hostname}.`,
    );
  url.pathname = "/postgres";
  return url;
}

async function admin(url, statement) {
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    return await sql.unsafe(statement);
  } finally {
    await sql.end();
  }
}

/** Whether a process of this machine still runs: its scratch is in use. */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * A migrated database of the flow's own, and `drop()` to remove it. The
 * name carries the process id, so two runs on one server never share one;
 * a scratch left by a run that was killed (its process gone) is dropped
 * first.
 */
export async function scratchDatabase(env = process.env) {
  const server = adminUrl(env);
  const name = `sandbox_factory_flow_${process.pid}`;
  if (!SCRATCH.test(name)) throw new Error(`Refusing database ${name}.`);
  const drop = (database) =>
    admin(server, `drop database if exists ${database} with (force)`);
  const existing = await admin(
    server,
    "select datname from pg_database where datname like 'sandbox_factory_flow_%'",
  );
  for (const { datname } of existing)
    if (SCRATCH.test(datname) && !running(Number(datname.split("_").at(-1))))
      await drop(datname);
  await drop(name);
  await admin(server, `create database ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  try {
    await runMigrations({ url: url.toString(), migrationsFolder });
  } catch (error) {
    await drop(name).catch(() => {});
    throw error;
  }
  return { name, url: url.toString(), drop: () => drop(name) };
}
