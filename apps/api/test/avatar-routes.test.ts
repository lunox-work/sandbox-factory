import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ObjectStore,
  OrganizationStore,
  OrganizationSummary,
} from "@sandbox-factory/db";
import sharp from "sharp";

import type { Auth } from "../src/auth.js";
import { UNSUPPORTED_FORMAT } from "../src/avatars/image.js";
import {
  NOT_AN_ADMIN,
  NO_FILE,
  PERSONAL_PICTURE,
  TOO_LARGE,
} from "../src/avatars/routes.js";
import { createAvatarService } from "../src/avatars/service.js";
import { createApp } from "../src/routes.js";

/**
 * The avatar routes, end to end through `createApp` with real sharp and an
 * in-memory bucket. What is pinned: who may write which picture, that the
 * stored bytes are the processed ones, that the column is written through
 * Better Auth for a user (so the session cookie refreshes) and through the
 * store for a team, and that the replaced object is cleaned up.
 */

const dana = { id: "user_1", email: "dana@example.test", name: "Dana" };
const signedIn = { cookie: "better-auth.session_token=test-token" };
const HASH =
  /^\/api\/avatars\/(user|organization)\/[\w-]+\/[0-9a-f]{64}\.webp$/;

function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: (key, bytes) => {
      objects.set(key, bytes);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(objects.get(key)),
    exists: (key) => Promise.resolve(objects.has(key)),
    remove: (key) => {
      objects.delete(key);
      return Promise.resolve();
    },
    signedUrl: () => Promise.reject(new Error("not used")),
  };
  return { store, objects };
}

/**
 * Better Auth, reduced to what these routes touch: the session read the
 * guard makes, and `updateUser`, which answers with a refreshed cookie the
 * route must pass on.
 */
function fakeAuth() {
  const updates: Array<{ image: unknown; cookie: string | null }> = [];
  const auth = {
    api: {
      getSession: ({ headers }: { headers: Headers }) =>
        Promise.resolve(
          headers.get("cookie") !== null
            ? { user: dana, session: { id: "session_1" } }
            : null,
        ),
      updateUser: ({
        headers,
        body,
      }: {
        headers: Headers;
        body: { image: unknown };
      }) => {
        updates.push({ image: body.image, cookie: headers.get("cookie") });
        return Promise.resolve({
          headers: new Headers([
            ["set-cookie", "better-auth.session_data=refreshed; Path=/"],
          ]),
          response: { status: true },
        });
      },
    },
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  } as unknown as Auth;
  return { auth, updates };
}

const acme: OrganizationSummary = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team",
  image: null,
};

function fakeOrganizations(
  options: {
    role?: string | undefined;
    organization?: OrganizationSummary;
  } = {},
) {
  let current = options.organization ?? acme;
  const logos: Array<string | null> = [];
  const store = {
    roleOf: () => Promise.resolve("role" in options ? options.role : "owner"),
    get: (id: string) =>
      Promise.resolve(id === current.id ? current : undefined),
    findBySlug: (slug: string) =>
      Promise.resolve(slug === current.slug ? current : undefined),
    setLogo: (_id: string, logo: string | null) => {
      logos.push(logo);
      current = { ...current, image: logo };
      return Promise.resolve();
    },
  } as unknown as OrganizationStore;
  return { store, logos };
}

function setup(
  options: {
    previousImage?: string | null;
    role?: string | undefined;
    organization?: OrganizationSummary;
    avatarsOff?: boolean;
  } = {},
) {
  const bucket = memoryStore();
  const { auth, updates } = fakeAuth();
  const organizations = fakeOrganizations({
    ...("role" in options ? { role: options.role } : {}),
    ...(options.organization === undefined
      ? {}
      : { organization: options.organization }),
  });
  const server = createApp({
    corsOrigins: ["http://localhost:5173"],
    auth,
    organizations: organizations.store,
    profiles: {
      image: () => Promise.resolve(options.previousImage ?? null),
    } as unknown as Parameters<typeof createApp>[0]["profiles"],
    ...(options.avatarsOff === true
      ? {}
      : { avatars: createAvatarService({ store: bucket.store }) }),
  });
  return {
    bucket,
    updates,
    logos: organizations.logos,
    request(path: string, init: RequestInit = {}, withSession = true) {
      return server.request(path, {
        ...init,
        headers: {
          ...(withSession ? signedIn : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    },
  };
}

async function png(
  width = 400,
  height = 300,
  background = "#3070c0",
): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background },
    })
      .png()
      .toBuffer(),
  );
}

function upload(bytes: Uint8Array, name = "me.png"): RequestInit {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
  return { method: "PUT", body: form };
}

// ---- reading --------------------------------------------------------------

test("an uploaded picture is served without a session, cacheable forever", async () => {
  const app = setup();
  const put = await app.request("/api/v1/me/avatar", upload(await png()));
  const { image } = (await put.json()) as { image: string };

  const res = await app.request(image, {}, false);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/webp");
  assert.equal(
    res.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const meta = await sharp(new Uint8Array(await res.arrayBuffer())).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 256);
});

test("a malformed or unknown avatar path is a 404", async () => {
  const app = setup();
  for (const path of [
    `/api/avatars/user/user_1/${"e".repeat(64)}.webp`,
    `/api/avatars/team/user_1/${"e".repeat(64)}.webp`,
    `/api/avatars/user/user_1/${"e".repeat(64)}.png`,
    "/api/avatars/user/user_1/short.webp",
  ]) {
    const res = await app.request(path, {}, false);
    assert.equal(res.status, 404, path);
  }
});

// ---- the caller's own picture ---------------------------------------------

test("uploading your picture stores the WebP and writes it through Better Auth", async () => {
  const app = setup();

  const res = await app.request("/api/v1/me/avatar", upload(await png()));

  assert.equal(res.status, 200);
  const { image } = (await res.json()) as { image: string };
  assert.match(image, HASH);
  assert.ok(image.startsWith("/api/avatars/user/user_1/"));
  // Stored under the key matching the path, and nothing else.
  assert.deepEqual(
    [...app.bucket.objects.keys()],
    [image.replace("/api/avatars/", "avatars/")],
  );
  // Written with the caller's own session, so the hook checks it against
  // the caller — and the refreshed cookie comes back to the browser.
  assert.deepEqual(app.updates, [{ image, cookie: signedIn.cookie }]);
  assert.match(res.headers.get("set-cookie") ?? "", /session_data=refreshed/);
});

test("replacing your picture deletes the one it replaced", async () => {
  const app = setup();
  const first = (await (
    await app.request("/api/v1/me/avatar", upload(await png(100, 100)))
  ).json()) as { image: string };

  const again = setup({ previousImage: first.image });
  // Carry the first object across so there is something to delete.
  for (const [key, bytes] of app.bucket.objects) {
    again.bucket.objects.set(key, bytes);
  }
  const second =
    (await // A different picture: the same one would land on the same key.
    (
      await again.request(
        "/api/v1/me/avatar",
        upload(await png(200, 120, "#20a060")),
      )
    ).json()) as { image: string };

  assert.notEqual(second.image, first.image);
  assert.deepEqual(
    [...again.bucket.objects.keys()],
    [second.image.replace("/api/avatars/", "avatars/")],
  );
});

test("a provider's picture is replaced in the column but nothing is deleted for it", async () => {
  const app = setup({ previousImage: "https://avatars.example/u/1.png" });

  const res = await app.request("/api/v1/me/avatar", upload(await png()));

  assert.equal(res.status, 200);
  assert.equal(app.bucket.objects.size, 1);
});

test("removing your picture clears the column and deletes the object", async () => {
  const first = setup();
  const { image } = (await (
    await first.request("/api/v1/me/avatar", upload(await png()))
  ).json()) as { image: string };

  const app = setup({ previousImage: image });
  for (const [key, bytes] of first.bucket.objects) {
    app.bucket.objects.set(key, bytes);
  }
  const res = await app.request("/api/v1/me/avatar", { method: "DELETE" });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { image: null });
  assert.deepEqual(app.updates, [{ image: null, cookie: signedIn.cookie }]);
  assert.equal(app.bucket.objects.size, 0);
});

test("a request with no file is refused", async () => {
  const app = setup();
  const form = new FormData();
  form.append("file", "not a file");

  for (const init of [
    { method: "PUT", body: form },
    { method: "PUT", body: new FormData() },
    {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    },
  ]) {
    const res = await app.request("/api/v1/me/avatar", init);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: NO_FILE });
  }
  assert.equal(app.updates.length, 0);
});

test("a file that is not an accepted picture is refused, and nothing is written", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/me/avatar",
    upload(new TextEncoder().encode("<svg/>"), "x.svg"),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: UNSUPPORTED_FORMAT });
  assert.equal(app.bucket.objects.size, 0);
  assert.equal(app.updates.length, 0);
});

test("a file over 5 MB is refused with a 413", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/me/avatar",
    upload(new Uint8Array(5 * 1024 * 1024 + 1)),
  );

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: TOO_LARGE });
});

test("a body far over the limit is cut off before it is parsed", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/me/avatar",
    upload(new Uint8Array(6 * 1024 * 1024)),
  );

  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: TOO_LARGE });
});

test("uploading without a session is a 401", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/me/avatar",
    upload(await png()),
    false,
  );

  assert.equal(res.status, 401);
  assert.equal(app.bucket.objects.size, 0);
});

// ---- a team's picture -----------------------------------------------------

test("an owner uploads a team's picture through the store", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/orgs/org_1/avatar",
    upload(await png()),
  );

  assert.equal(res.status, 200);
  const { image } = (await res.json()) as { image: string };
  assert.ok(image.startsWith("/api/avatars/organization/org_1/"));
  assert.deepEqual(app.logos, [image]);
  // Not through Better Auth: no session carries a team's picture.
  assert.equal(app.updates.length, 0);
});

test("an admin may change a team's picture too", async () => {
  const app = setup({ role: "admin" });

  const res = await app.request(
    "/api/v1/orgs/org_1/avatar",
    upload(await png()),
  );

  assert.equal(res.status, 200);
});

test("a plain member is told who can change the picture", async () => {
  const app = setup({ role: "member" });

  const res = await app.request(
    "/api/v1/orgs/org_1/avatar",
    upload(await png()),
  );

  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: NOT_AN_ADMIN });
  assert.equal(app.bucket.objects.size, 0);
  assert.deepEqual(app.logos, []);
});

test("a non-member gets a 404, as for any other organization route", async () => {
  const app = setup({ role: undefined });

  const res = await app.request(
    "/api/v1/orgs/org_1/avatar",
    upload(await png()),
  );

  assert.equal(res.status, 404);
  assert.equal(app.bucket.objects.size, 0);
});

test("a personal workspace has no picture of its own", async () => {
  const app = setup({
    organization: { ...acme, kind: "personal", slug: "dana" },
  });

  for (const init of [upload(await png()), { method: "DELETE" }]) {
    const res = await app.request("/api/v1/orgs/org_1/avatar", init);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: PERSONAL_PICTURE,
      code: "PERSONAL_ORGANIZATION",
    });
  }
  assert.deepEqual(app.logos, []);
});

test("removing a team's picture clears it and deletes the object", async () => {
  const first = setup();
  const { image } = (await (
    await first.request("/api/v1/orgs/org_1/avatar", upload(await png()))
  ).json()) as { image: string };

  const app = setup({ organization: { ...acme, image } });
  for (const [key, bytes] of first.bucket.objects) {
    app.bucket.objects.set(key, bytes);
  }
  const res = await app.request("/api/v1/orgs/org_1/avatar", {
    method: "DELETE",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { image: null });
  assert.deepEqual(app.logos, [null]);
  assert.equal(app.bucket.objects.size, 0);
});

test("an unreadable team upload is refused before anything is written", async () => {
  const app = setup();

  const res = await app.request(
    "/api/v1/orgs/org_1/avatar",
    upload(new TextEncoder().encode("hello")),
  );

  assert.equal(res.status, 400);
  assert.deepEqual(app.logos, []);
});

// ---- configuration and the public lookup ------------------------------------

test("without object storage every avatar route is a 404", async () => {
  const app = setup({ avatarsOff: true });

  for (const [path, init] of [
    ["/api/v1/me/avatar", upload(await png())],
    ["/api/v1/orgs/org_1/avatar", upload(await png())],
    [`/api/avatars/user/user_1/${"e".repeat(64)}.webp`, {}],
  ] as const) {
    const res = await app.request(path, init);
    assert.equal(res.status, 404, path);
  }
});

test("the lookup by handle stays thin: no picture", async () => {
  const app = setup({
    organization: {
      ...acme,
      image: `/api/avatars/organization/org_1/${"f".repeat(64)}.webp`,
    },
  });

  const res = await app.request("/api/v1/orgs/by-handle/acme");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    kind: "team",
  });
});
