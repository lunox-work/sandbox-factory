import assert from "node:assert/strict";
import { test } from "node:test";

import type { Connection } from "../src/client.js";
import { type MigrateDeps, runMigrations } from "../src/migrate.js";
import type { Database } from "../src/errors.js";

/**
 * The runner's logic: open one connection, run the migrator, close whichever
 * way that goes. Injected collaborators test that with no database; the SQL
 * itself is verified with `make migrate`.
 */
function deps(run: MigrateDeps["run"] = async () => {}): {
  deps: MigrateDeps;
  closed: () => number;
  urls: string[];
  maxes: (number | undefined)[];
  folders: string[];
} {
  let closes = 0;
  const urls: string[] = [];
  const maxes: (number | undefined)[] = [];
  const folders: string[] = [];

  return {
    urls,
    maxes,
    folders,
    closed: () => closes,
    deps: {
      connect: ({ url, max }) => {
        urls.push(url);
        maxes.push(max);
        return {
          db: {} as Database,
          close: async () => {
            closes += 1;
          },
        } satisfies Connection;
      },
      run: async (db, config) => {
        folders.push(config.migrationsFolder);
        await run(db, config);
      },
    },
  };
}

test("runMigrations closes the connection on success", async () => {
  const h = deps();
  await runMigrations({ url: "postgres://x" }, h.deps);
  assert.equal(h.closed(), 1);
});

test("runMigrations closes the connection when the migration fails", async () => {
  // A failed migration that leaks its connection leaves the process hanging.
  const h = deps(async () => {
    throw new Error("syntax error at or near");
  });
  await assert.rejects(
    () => runMigrations({ url: "postgres://x" }, h.deps),
    /syntax error/,
  );
  assert.equal(h.closed(), 1);
});

test("runMigrations uses a single connection", async () => {
  const h = deps();
  await runMigrations({ url: "postgres://x" }, h.deps);
  assert.deepEqual(h.maxes, [1]);
});

test("runMigrations passes the url through", async () => {
  const h = deps();
  await runMigrations({ url: "postgres://example/db" }, h.deps);
  assert.deepEqual(h.urls, ["postgres://example/db"]);
});

test("runMigrations defaults the migrations folder to drizzle", async () => {
  const h = deps();
  await runMigrations({ url: "postgres://x" }, h.deps);
  assert.deepEqual(h.folders, ["drizzle"]);
});

test("runMigrations honours an explicit migrations folder", async () => {
  const h = deps();
  await runMigrations(
    { url: "postgres://x", migrationsFolder: "/abs/drizzle" },
    h.deps,
  );
  assert.deepEqual(h.folders, ["/abs/drizzle"]);
});
