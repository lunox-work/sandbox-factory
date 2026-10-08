/** @vitest-environment node */
import { request } from "node:http";
import { runInNewContext } from "node:vm";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { expect, test, vi } from "vitest";
import { createServer } from "vite";

const ROOT = join(import.meta.dirname, "..");
const MODE = "host-allowlist-test";

async function checkHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        headers: { host },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("Vite loads dev hostnames from an env file and keeps unrelated hosts blocked", async () => {
  const envFile = join(ROOT, `.env.${MODE}.local`);
  vi.stubEnv("VITE_DEV_ALLOWED_HOSTS", undefined);
  await writeFile(
    envFile,
    "VITE_DEV_ALLOWED_HOSTS= devbox, .example.test , ,\n",
  );
  const server = await createServer({
    root: ROOT,
    mode: MODE,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  try {
    await server.listen();
    const port = (server.httpServer?.address() as AddressInfo).port;
    expect(await checkHost(port, "localhost")).toBe(200);
    expect(await checkHost(port, "devbox")).toBe(200);
    expect(await checkHost(port, "machine.example.test")).toBe(200);
    expect(await checkHost(port, "untrusted.test")).toBe(403);
  } finally {
    await server.close();
    await rm(envFile, { force: true });
    vi.unstubAllEnvs();
  }
});

test("Vite defaults to localhost hosts when the extra list is empty", async () => {
  vi.stubEnv("VITE_DEV_ALLOWED_HOSTS", "");
  const server = await createServer({
    root: ROOT,
    mode: MODE,
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  try {
    await server.listen();
    const port = (server.httpServer?.address() as AddressInfo).port;
    expect(await checkHost(port, "localhost")).toBe(200);
    expect(await checkHost(port, "devbox")).toBe(403);
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});

test("the optional dev origin preserves deep links and does not redirect its own origin", async () => {
  const origin = "https://devbox.example.test";
  vi.stubEnv("VITE_DEV_CANONICAL_ORIGIN", origin);
  const server = await createServer({
    root: ROOT,
    mode: MODE,
    server: { middlewareMode: true },
    logLevel: "silent",
  });
  try {
    const html = await server.transformIndexHtml(
      "/",
      "<html><head></head></html>",
    );
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeDefined();
    const replace = vi.fn();
    const location = {
      origin: "http://devbox:5173",
      pathname: "/org/repo",
      search: "?tab=files",
      hash: "#readme",
      replace,
    };
    runInNewContext(script ?? "", { window: { location } });
    expect(replace).toHaveBeenCalledWith(origin + "/org/repo?tab=files#readme");
    replace.mockClear();
    runInNewContext(script ?? "", {
      window: { location: { ...location, origin } },
    });
    expect(replace).not.toHaveBeenCalled();
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});

test("dev pages have no canonical redirect by default", async () => {
  vi.stubEnv("VITE_DEV_CANONICAL_ORIGIN", "");
  const server = await createServer({
    root: ROOT,
    mode: MODE,
    server: { middlewareMode: true },
    logLevel: "silent",
  });
  try {
    const html = await server.transformIndexHtml(
      "/",
      "<html><head></head></html>",
    );
    expect(html).not.toContain("window.location.replace");
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});
