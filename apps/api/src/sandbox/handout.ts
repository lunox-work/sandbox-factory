/**
 * The handout's three answers: the listing (`…/handout`), the archive
 * (`…/archive`) and the paged files (`…/handout/files`), for a version in
 * `owner`. None decides who may ask: the workspace's routes check the
 * caller is an owner or admin there, and a contributor's routes
 * (`contributors.ts`) that the caller holds a live assignment to the
 * version, then each calls the same answer here.
 *
 * The handout is the public project a developer clones, as the build
 * committed it (`project/…`, at its project path), and of the hidden
 * tests only their count and commitment hash. The count is the tests the
 * judge stages (`stagedHiddenTest`: never the name table beside them).
 * The hash is the one the build recorded (`hiddenCommitment`, version 2:
 * each test at the path the judge stages it at in the version's layout);
 * a build made before recorded none and keeps the hash it always showed
 * (version 1: every file under `private/` keyed `tests/private/…`), so a
 * hash a contributor noted never changes under them. No hidden test's
 * path or body leaves here, so an agent may read it.
 *
 * The archive (one `.zip`, everything under one folder named by the
 * sandbox's id and version number) and, for an agent that cannot unpack
 * one, pages of the same files as text, are built from the handout's list
 * alone (`project.ts`), every file checked against the sha256 it lists, so
 * nothing under `private/` is ever in them.
 */

import {
  handoutFilesQuerySchema,
  handoutFilesSchema,
  sandboxHandoutSchema,
} from "@sandbox-factory/shared";
import { hiddenSha256 } from "duediligence/api";
import type { Context } from "hono";
import {
  HIDDEN_COMMITMENT_VERSION,
  layoutOf,
  stagedHiddenTest,
  type SandboxBuildManifest,
} from "sandbox-factory";

import type { SandboxRouteOptions } from "./options.js";
import {
  projectArchive,
  projectPage,
  projectSha256,
  publicProject,
} from "./project.js";

type Stores = Pick<SandboxRouteOptions, "sandboxes" | "runs" | "artifacts"> & {
  readonly objects: Pick<SandboxRouteOptions["objects"], "get">;
};

/**
 * Whether `If-None-Match` names `etag` (RFC 9110 13.1.2: weak comparison,
 * or `*`).
 */
export function matchesEtag(header: string | undefined, etag: string) {
  if (header === undefined) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return header
    .split(",")
    .some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

const PROJECT_REFUSALS = {
  not_built: [409, "This version has no committed build to hand out."],
  project_too_large: [
    409,
    "This project is too large to pack; read its files one by one.",
  ],
  unsafe_path: [502, "A file in this build has a path that cannot be packed."],
  artifacts_unavailable: [502, "A file in this build could not be read."],
  project_mismatch: [
    502,
    "A file in storage is not the one the build recorded, so nothing was served.",
  ],
  invalid_cursor: [400, "That cursor is not one this route gave."],
  cursor_stale: [
    409,
    "The project was rebuilt since that cursor was given. Start from the first page.",
  ],
} as const;

function refuseProject(
  c: Context,
  versionId: string,
  refusal: { code: keyof typeof PROJECT_REFUSALS; path?: string },
) {
  const [status, error] = PROJECT_REFUSALS[refusal.code];
  // A storage fault or a mismatch is the operator's to see; the path is
  // public (it is in the handout), the bytes never logged.
  if (status === 502)
    console.error(`project_${refusal.code}`, versionId, refusal.path ?? "");
  return c.json({ error, code: refusal.code }, status);
}

/**
 * `GET …/handout`: the public files, and the hidden suite's count and hash.
 * `audience: "contributor"` leaves out the build run: its id is the
 * workspace's, not the handout's.
 */
export async function handoutResponse(
  c: Context,
  options: Stores,
  owner: string,
  versionId: string,
  audience: "workspace" | "contributor" = "workspace",
): Promise<Response> {
  const project = await publicProject(options, owner, versionId);
  if (project === null) return c.json({ error: "Not found." }, 404);
  const unavailable = () =>
    c.json(
      {
        error: "The hidden tests could not be read.",
        code: "artifacts_unavailable",
      },
      502,
    );
  const manifestFile = project.artifacts.find(
    (file) => file.path === "build-manifest.json",
  );
  type Recorded = Pick<SandboxBuildManifest, "layout" | "hiddenCommitment">;
  let manifest: Recorded | null = null;
  if (manifestFile !== undefined) {
    const bytes = await options.objects.get(manifestFile.objectKey);
    if (bytes === undefined) return unavailable();
    try {
      manifest = JSON.parse(Buffer.from(bytes).toString("utf8")) as Recorded;
    } catch {
      // A stored manifest that is not JSON is the operator's to see.
      console.error("handout_manifest_unreadable", versionId);
      return unavailable();
    }
  }
  const layout = layoutOf(manifest ?? {});
  const hiddenTests = project.artifacts.filter(
    (file) => stagedHiddenTest(layout, file.path) !== null,
  ).length;
  const recorded = manifest?.hiddenCommitment;
  let hash: string | null = null;
  let hashVersion: 1 | 2 = HIDDEN_COMMITMENT_VERSION;
  if (recorded?.version === HIDDEN_COMMITMENT_VERSION) {
    // Recorded over what the build wrote; the artifacts must still be it.
    if (recorded.hiddenTests !== hiddenTests) return unavailable();
    hash = recorded.hiddenSha256;
  } else {
    const legacy = project.artifacts.filter((file) =>
      file.path.startsWith("private/"),
    );
    // Unbuilt, it has nothing to hash yet; built, the old rule's hash.
    if (manifest !== null || legacy.length > 0) hashVersion = 1;
    if (legacy.length > 0) {
      const map: Record<string, Uint8Array> = {};
      for (const file of legacy) {
        const bytes = await options.objects.get(file.objectKey);
        if (bytes === undefined) return unavailable();
        map[`tests/private/${file.path.slice("private/".length)}`] = bytes;
      }
      hash = hiddenSha256(map, Object.keys(map).sort());
    }
  }
  c.header("Cache-Control", "no-store");
  return c.json(
    sandboxHandoutSchema.parse({
      versionId: project.versionId,
      ...(audience === "contributor" ? {} : { run: project.run }),
      files: project.files.map(({ path, sizeBytes, sha256 }) => ({
        path,
        sizeBytes,
        sha256,
      })),
      hiddenTests,
      hiddenSha256: hash,
      hiddenSha256Version: hashVersion,
    }),
  );
}

/**
 * `GET …/archive`. HEAD is answered by the same GET (Hono strips the
 * body); it stops before reading a byte of the project.
 */
export async function archiveResponse(
  c: Context,
  options: Stores,
  owner: string,
  versionId: string,
): Promise<Response> {
  const project = await publicProject(options, owner, versionId);
  if (project === null) return c.json({ error: "Not found." }, 404);
  if (project.files.length === 0)
    return refuseProject(c, versionId, { code: "not_built" });
  const etag = `"${projectSha256(project)}"`;
  const headers = (zip: boolean) => {
    c.header("ETag", etag);
    // Private to the signed-in reader, and checked again each time: the
    // ETag makes that a 304 with no object read.
    c.header("Cache-Control", "private, no-cache");
    if (!zip) return;
    c.header("Content-Type", "application/zip");
    c.header(
      "Content-Disposition",
      `attachment; filename="${project.root}.zip"`,
    );
  };
  if (matchesEtag(c.req.header("if-none-match"), etag)) {
    headers(false);
    return c.body(null, 304);
  }
  if (c.req.method === "HEAD") {
    headers(true);
    return c.body(null, 200);
  }
  const archive = await projectArchive(options.objects, project);
  if ("code" in archive) return refuseProject(c, versionId, archive);
  const chunks = [...archive.chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
  headers(true);
  c.header("Content-Length", String(archive.sizeBytes));
  return c.body(body, 200);
}

/** `GET …/handout/files?cursor=&maxBytes=`: one page of the files. */
export async function handoutFilesResponse(
  c: Context,
  options: Stores,
  owner: string,
  versionId: string,
): Promise<Response> {
  const query = handoutFilesQuerySchema.safeParse(c.req.query());
  if (!query.success)
    return c.json({ error: "Invalid query.", issues: query.error.issues }, 400);
  const project = await publicProject(options, owner, versionId);
  if (project === null) return c.json({ error: "Not found." }, 404);
  const page = await projectPage(
    options.objects,
    project,
    query.data.cursor ?? null,
    query.data.maxBytes,
  );
  if ("code" in page) return refuseProject(c, versionId, page);
  c.header("Cache-Control", "no-store");
  return c.json(
    handoutFilesSchema.parse({ versionId: project.versionId, ...page }),
  );
}
