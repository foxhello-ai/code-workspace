import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { buildApp } from "./app.js";
import { config } from "./config.js";

let root: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const source = 'console.log("static asset");'.repeat(100);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workspace-static-"));
  await mkdir(path.join(root, "assets"));
  await Promise.all([
    writeFile(path.join(root, "index.html"), "<!doctype html><title>Code Workspace</title>"),
    writeFile(path.join(root, "assets", "app-Ab12_cd3.js"), source),
    writeFile(path.join(root, "assets", "app-Ab12_cd3.js.br"), brotliCompressSync(source)),
    writeFile(path.join(root, "assets", "app-Ab12_cd3.js.gz"), gzipSync(source)),
    writeFile(path.join(root, "assets", "style-12345678.css"), "body{color:white}"),
    writeFile(path.join(root, "assets", "plain.js"), source)
  ]);
  app = await buildApp({ webRoot: root });
  app.log.level = "silent";
});
afterEach(async () => { await app.close(); await rm(root, { force: true, recursive: true }); });

it("keeps hashed assets immutable and revalidates HTML and unversioned files", async () => {
  for (const url of ["/assets/app-Ab12_cd3.js", "/assets/style-12345678.css"]) {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  }
  for (const url of ["/", "/index.html", "/workspace/deep-link", "/assets/plain.js"]) {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-cache");
  }
});

it("negotiates Brotli and gzip while retaining MIME type, cache policy and Vary", async () => {
  for (const [encoding, decompress] of [["br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
    const response = await app.inject({ url: "/assets/app-Ab12_cd3.js", headers: { "accept-encoding": encoding } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(String(response.headers.vary).toLowerCase()).toContain("accept-encoding");
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(decompress(response.rawPayload).toString()).toBe(source);
  }
  const plain = await app.inject({ url: "/assets/app-Ab12_cd3.js" });
  expect(plain.body).toBe(source);
  expect(String(plain.headers.vary).toLowerCase()).toContain("accept-encoding");
});

it("returns uncached 404 for missing chunks instead of serving HTML", async () => {
  const response = await app.inject({ url: "/assets/old-chunk-12345678.js" });
  expect(response.statusCode).toBe(404);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-type"]).toContain("application/json");
});

it("never caches authentication responses, API errors or private workspace data", async () => {
  for (const url of ["/api/auth/status", "/api/workspace"]) {
    expect((await app.inject({ url })).headers["cache-control"]).toBe("no-store");
  }
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: config.appPassword } });
  expect(login.headers["cache-control"]).toBe("no-store");
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const opened = await app.inject({ method: "POST", url: "/api/workspace/open", headers: { cookie }, payload: { path: root, background: true } });
  expect(opened.statusCode).toBe(200);
  expect(opened.headers["cache-control"]).toBe("no-store");
  const privateData = await app.inject({ url: "/api/workspace?snapshot=1", headers: { cookie } });
  expect(privateData.statusCode).toBe(200);
  expect(privateData.headers["cache-control"]).toBe("no-store");
});
