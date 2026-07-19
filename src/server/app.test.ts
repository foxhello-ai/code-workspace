import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";

let root: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "code-workspace-test-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: root });
  await writeFile(path.join(root, "hello.txt"), "one\n");
  execFileSync("git", ["add", "hello.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  app = await buildApp();
  await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: root } });
});

afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

describe("workspace API", () => {
  it("closes the current workspace without requiring a JSON body", async () => {
    const closed = await app.inject({ method: "POST", url: "/api/workspace/close" });
    expect(closed.statusCode).toBe(200);
    const current = await app.inject({ method: "GET", url: "/api/workspace" });
    expect(current.statusCode).toBe(404);
  });

  it("reads and safely saves a file", async () => {
    const read = await app.inject({ method: "GET", url: "/api/files/content?path=hello.txt" });
    expect(read.statusCode).toBe(200);
    const file = read.json().data;
    const saved = await app.inject({ method: "PUT", url: "/api/files/content", payload: { path: "hello.txt", content: "two\n", expectedVersion: file.version } });
    expect(saved.statusCode).toBe(200);
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("two\n");
  });

  it("rejects saving over an external change", async () => {
    const read = await app.inject({ method: "GET", url: "/api/files/content?path=hello.txt" });
    const file = read.json().data;
    await writeFile(path.join(root, "hello.txt"), "external\n");
    const saved = await app.inject({ method: "PUT", url: "/api/files/content", payload: { path: "hello.txt", content: "editor\n", expectedVersion: file.version } });
    expect(saved.statusCode).toBe(409);
    expect(saved.json().error.code).toBe("FILE_VERSION_CONFLICT");
  });

  it("accepts UTF-8 when a multibyte character crosses the former sample boundary", async () => {
    const content = `${"a".repeat(8191)}中\n`;
    await writeFile(path.join(root, "boundary.md"), content);
    const response = await app.inject({ method: "GET", url: "/api/files/content?path=boundary.md" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.encoding).toBe("utf-8");
    expect(response.json().data.content).toBe(content);
  });

  it("reports unstaged, staged and untracked changes and diff content", async () => {
    await writeFile(path.join(root, "hello.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    const status = await app.inject({ method: "GET", url: "/api/git/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.files.some((file: { path: string }) => file.path === "hello.txt")).toBe(true);
    expect(status.json().data.files.some((file: { path: string }) => file.path === "new.txt")).toBe(true);
    const diff = await app.inject({ method: "GET", url: "/api/git/diff?scope=all&path=hello.txt" });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().data.files[0].oldText).toBe("one\n");
    expect(diff.json().data.files[0].newText).toBe("changed\n");
  });

  it("returns commit history, detail and commit diff", async () => {
    const history = await app.inject({ method: "GET", url: "/api/git/history" });
    expect(history.statusCode).toBe(200);
    const hash = history.json().data.items[0].hash;
    const detail = await app.inject({ method: "GET", url: `/api/git/commits/${hash}` });
    expect(detail.json().data.subject).toBe("initial");
    const diff = await app.inject({ method: "GET", url: `/api/git/diff/commits/${hash}?path=hello.txt` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().data.files[0].newText).toBe("one\n");
  });
});
