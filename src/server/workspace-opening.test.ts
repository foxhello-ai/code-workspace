import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { buildApp } from "./app.js";
import { GitRunner } from "./infrastructure/git-runner.js";
import { GitService } from "./services/git-service.js";
import { WatchService } from "./services/watch-service.js";

let root: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const releases: Array<() => void> = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
const open = () => app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: root, background: true } });
const snapshot = async () => (await app.inject({ url: "/api/workspace?snapshot=1" })).json().data;
async function ready() { await vi.waitFor(async () => expect((await snapshot()).initialization.status).toBe("ready"), { timeout: 6000 }); return snapshot(); }
function blockDiscovery() {
  const blocked = gate();
  const original = GitRunner.prototype.run;
  let entered = false;
  vi.spyOn(GitRunner.prototype, "run").mockImplementation(async function(args, options) {
    if (!entered && args[0] === "rev-parse" && args[1] === "--show-toplevel") { entered = true; await blocked.promise; }
    return original.call(this, args, options);
  });
  return { ...blocked, entered: () => entered };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "workspace-opening-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"], { cwd: root });
  await writeFile(path.join(root, "hello.txt"), "hello\n");
  app = await buildApp({ disableAuth: true });
  app.log.level = "silent";
});
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  await app.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("returns a validated workspace and usable files while Git discovery is blocked", async () => {
  const blocked = blockDiscovery();
  const response = await open();
  expect(response.statusCode).toBe(200);
  expect(response.json().data.initialization).toMatchObject({ status: "loading", phase: "discovery" });
  await vi.waitFor(() => expect(blocked.entered()).toBe(true));
  const tree = await app.inject({ url: "/api/files/tree" });
  expect(tree.json().data).toEqual([expect.objectContaining({ name: "hello.txt" })]);
  expect(tree.json().data[0].gitTrackedState).toBeUndefined();
  const file = (await app.inject({ url: "/api/files/content?path=hello.txt" })).json().data;
  expect((await app.inject({ method: "PUT", url: "/api/files/content", payload: { path: "hello.txt", content: "edited during loading\n", expectedVersion: file.version } })).statusCode).toBe(200);
  expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("edited during loading\n");
  expect((await app.inject({ url: "/api/workspace" })).json().data.initialization.status).toBe("loading");
  expect((await app.inject({ url: "/api/git/status" })).json().error.code).toBe("WORKSPACE_LOADING");
  expect((await app.inject({ method: "POST", url: "/api/git/editor-state", payload: { workspaceId: response.json().data.id, paths: ["hello.txt"], dirtyPaths: [] } })).statusCode).toBe(200);
  expect((await app.inject({ method: "DELETE", url: "/api/files?path=hello.txt&confirmed=true" })).json().error.code).toBe("WORKSPACE_LOADING");
  blocked.release();
  const info = await ready();
  expect(info.repositories).toHaveLength(1);
  expect(info.changedFileCount).toBe(1);
  expect((await app.inject({ url: "/api/files/tree" })).json().data[0].gitTrackedState).toBe("untracked");
});

it("validates missing and non-directory paths before exposing a workspace", async () => {
  for (const [target, code] of [[path.join(root, "missing"), 404], [path.join(root, "hello.txt"), 400]] as const) {
    const response = await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: target, background: true } });
    expect(response.statusCode).toBe(code);
    expect((await app.inject({ url: "/api/workspace?snapshot=1" })).statusCode).toBe(404);
  }
});

it("discards late discovery after closing and reopening the same directory", async () => {
  const blocked = blockDiscovery();
  const started = vi.spyOn(WatchService.prototype, "start");
  const first = (await open()).json().data;
  await vi.waitFor(() => expect(blocked.entered()).toBe(true));
  expect((await app.inject({ method: "POST", url: "/api/workspace/close" })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/workspace?snapshot=1" })).statusCode).toBe(404);
  const second = (await open()).json().data;
  expect(second.initialization.id).not.toBe(first.initialization.id);
  await ready();
  blocked.release();
  expect((await snapshot()).initialization.id).toBe(second.initialization.id);
  await app.close(); // waits for every detached initialization to settle
  expect(started).toHaveBeenCalledTimes(1);
  expect(started.mock.calls[0][0]?.info.initialization?.id).toBe(second.initialization.id);
});

it("does not let an old status calculation overwrite a newer workspace", async () => {
  const blocked = gate();
  const original = GitService.prototype.status;
  let entered = false;
  vi.spyOn(GitService.prototype, "status").mockImplementation(async function(...args) {
    if (!entered) { entered = true; await blocked.promise; }
    return original.apply(this, args);
  });
  const first = (await open()).json().data;
  await vi.waitFor(() => expect(entered).toBe(true));
  const second = (await open()).json().data;
  expect(second.initialization.id).not.toBe(first.initialization.id);
  await ready();
  blocked.release();
  await vi.waitFor(async () => expect((await snapshot()).initialization).toMatchObject({ id: second.initialization.id, status: "ready" }));
  expect((await snapshot()).changedFileCount).toBe(1);
});

it("reports background initialization failure and retries without reopening files", async () => {
  const original = GitRunner.prototype.run;
  let fail = true;
  vi.spyOn(GitRunner.prototype, "run").mockImplementation(function(args, options) {
    if (fail && args[0] === "rev-parse" && args[1] === "--show-toplevel") { fail = false; return Promise.reject(new Error("discovery unavailable")); }
    return original.call(this, args, options);
  });
  const first = (await open()).json().data;
  await vi.waitFor(async () => expect((await snapshot()).initialization).toMatchObject({ status: "error", error: "discovery unavailable" }));
  expect((await app.inject({ url: "/api/files/content?path=hello.txt" })).statusCode).toBe(200);
  const retried = await app.inject({ method: "POST", url: "/api/workspace/retry", payload: { initializationId: first.initialization.id } });
  expect(retried.statusCode).toBe(200);
  expect(retried.json().data.initialization.id).not.toBe(first.initialization.id);
  expect(retried.json().data.openedAt).toBe(first.openedAt);
  const info = await ready();
  expect(info.changedFileCount).toBe(1);
  expect((await app.inject({ method: "POST", url: "/api/workspace/retry", payload: { initializationId: first.initialization.id } })).statusCode).toBe(409);
});
