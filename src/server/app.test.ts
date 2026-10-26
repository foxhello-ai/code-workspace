import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { GitRunner } from "./infrastructure/git-runner.js";

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
  app = await buildApp({ disableAuth: true });
  await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: root } });
});

afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

describe("workspace API", () => {
  it("waits for a running watcher Git refresh before closing the workspace", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let blocked = false;
    const original = GitRunner.prototype.run;
    const spy = vi.spyOn(GitRunner.prototype, "run").mockImplementation(async function (this: GitRunner, args, options) {
      const result = await original.call(this, args, options);
      if (args[0] === "symbolic-ref") { blocked = true; await gate; }
      return result;
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      await writeFile(path.join(root, "hello.txt"), "trigger watcher refresh\n");
      await vi.waitFor(() => expect(blocked).toBe(true), { timeout: 5000 });
      let closed = false;
      const closing = app.inject({ method: "POST", url: "/api/workspace/close" }).then(response => { closed = true; return response; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(closed).toBe(false);
      release();
      expect((await closing).statusCode).toBe(200);
    } finally { release(); spy.mockRestore(); }
  });

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

  it("shows symlink targets as files or expandable directories", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "code-workspace-linked-"));
    try {
      await mkdir(path.join(outside, "nested"));
      await writeFile(path.join(outside, "nested", "child.txt"), "linked child\n");
      await writeFile(path.join(outside, "linked.md"), "linked file\n");
      await symlink(path.join(outside, "nested"), path.join(root, "linked-dir"), "dir");
      await symlink(path.join(outside, "linked.md"), path.join(root, "linked-file.md"));

      const rootTree = await app.inject({ method: "GET", url: "/api/files/tree" });
      expect(rootTree.statusCode).toBe(200);
      const entries = rootTree.json().data as Array<{ name: string; kind: string; expandable: boolean }>;
      expect(entries.find((entry) => entry.name === "linked-dir")).toMatchObject({ kind: "directory", expandable: true });
      expect(entries.find((entry) => entry.name === "linked-file.md")).toMatchObject({ kind: "file", expandable: false });

      const linkedTree = await app.inject({ method: "GET", url: "/api/files/tree?path=linked-dir" });
      expect(linkedTree.statusCode).toBe(200);
      expect(linkedTree.json().data.some((entry: { name: string }) => entry.name === "child.txt")).toBe(true);

      const linkedFile = await app.inject({ method: "GET", url: "/api/files/content?path=linked-file.md" });
      expect(linkedFile.statusCode).toBe(200);
      expect(linkedFile.json().data.content).toBe("linked file\n");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("discovers symlink Git repositories by configured depth", async () => {
    const aggregate = await mkdtemp(path.join(os.tmpdir(), "code-workspace-aggregate-"));
    const repoA = await mkdtemp(path.join(os.tmpdir(), "code-workspace-repo-a-"));
    const repoB = await mkdtemp(path.join(os.tmpdir(), "code-workspace-repo-b-"));
    const originalDepth = config.gitDiscoveryDepth;
    try {
      for (const repo of [repoA, repoB]) {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Tester"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: repo });
        await writeFile(path.join(repo, "file.txt"), "one\n");
        execFileSync("git", ["add", "file.txt"], { cwd: repo });
        execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
      }
      await mkdir(path.join(aggregate, "services"));
      await symlink(repoA, path.join(aggregate, "repo-a"), "dir");
      await symlink(repoB, path.join(aggregate, "services", "repo-b"), "dir");

      config.gitDiscoveryDepth = 1;
      const depthOne = await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: aggregate } });
      expect(depthOne.statusCode).toBe(200);
      expect(depthOne.json().data.repositories.map((repo: { workspacePath: string }) => repo.workspacePath)).toEqual(["repo-a"]);

      config.gitDiscoveryDepth = 2;
      const depthTwo = await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: aggregate } });
      expect(depthTwo.statusCode).toBe(200);
      expect(depthTwo.json().data.repositories.map((repo: { workspacePath: string }) => repo.workspacePath)).toEqual(["repo-a", "services/repo-b"]);
    } finally {
      config.gitDiscoveryDepth = originalDepth;
      await app.inject({ method: "POST", url: "/api/workspace/close" });
      await Promise.all([aggregate, repoA, repoB].map((item) => rm(item, { recursive: true, force: true })));
    }
  });

  it("keeps Git APIs available when watcher file limit is exceeded", async () => {
    const originalMaxFiles = config.watchMaxFiles;
    try {
      config.watchMaxFiles = 1;
      const opened = await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: root } });
      expect(opened.statusCode).toBe(200);

      const history = await app.inject({ method: "GET", url: "/api/git/history" });
      expect(history.statusCode).toBe(200);
      expect(history.json().data.items[0].subject).toBe("initial");
    } finally {
      config.watchMaxFiles = originalMaxFiles;
    }
  });

  it("keeps workspace state isolated by browser session", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "code-workspace-other-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: other });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: other });
      execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: other });
      await writeFile(path.join(other, "other.txt"), "other\n");
      execFileSync("git", ["add", "other.txt"], { cwd: other });
      execFileSync("git", ["commit", "-qm", "other"], { cwd: other });

      const sessionA = { "x-code-workspace-session": "session-a" };
      const sessionB = { "x-code-workspace-session": "session-b" };
      await app.inject({ method: "POST", url: "/api/workspace/open", headers: sessionA, payload: { path: root } });
      await app.inject({ method: "POST", url: "/api/workspace/open", headers: sessionB, payload: { path: other } });

      const currentA = await app.inject({ method: "GET", url: "/api/workspace", headers: sessionA });
      const currentB = await app.inject({ method: "GET", url: "/api/workspace", headers: sessionB });
      expect(currentA.json().data.rootPath).toBe(await realpath(root));
      expect(currentB.json().data.rootPath).toBe(await realpath(other));

      await app.inject({ method: "POST", url: "/api/workspace/close", headers: sessionA });
      expect((await app.inject({ method: "GET", url: "/api/workspace", headers: sessionA })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/workspace", headers: sessionB })).json().data.rootPath).toBe(await realpath(other));
    } finally {
      await app.inject({ method: "POST", url: "/api/workspace/close", headers: { "x-code-workspace-session": "session-b" } });
      await rm(other, { recursive: true, force: true });
    }
  });

  it("marks visible files by Git control state", async () => {
    await writeFile(path.join(root, "clean.txt"), "clean\n");
    execFileSync("git", ["add", "clean.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "tracked file"], { cwd: root });
    await writeFile(path.join(root, "untracked.txt"), "new\n");

    const tree = await app.inject({ method: "GET", url: "/api/files/tree" });
    expect(tree.statusCode).toBe(200);
    const entries = tree.json().data as Array<{ name: string; gitTrackedState?: string }>;
    expect(entries.find((entry) => entry.name === "clean.txt")?.gitTrackedState).toBe("tracked");
    expect(entries.find((entry) => entry.name === "untracked.txt")?.gitTrackedState).toBe("untracked");
  });

  it("reports Git change counts for workspaces, repository roots and recent summaries", async () => {
    await writeFile(path.join(root, "hello.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");

    const current = await app.inject({ method: "GET", url: "/api/workspace" });
    expect(current.statusCode).toBe(200);
    expect(current.json().data.changedRepositoryCount).toBe(1);
    expect(current.json().data.changedFileCount).toBe(2);
    expect(current.json().data.repositories[0].changedFileCount).toBe(2);

    const summary = await app.inject({ method: "POST", url: "/api/workspaces/change-summary", payload: { paths: [root] } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().data[0]).toMatchObject({ path: root, repositoryCount: 1, changedRepositoryCount: 1, changedFileCount: 2 });

    const aggregate = await mkdtemp(path.join(os.tmpdir(), "code-workspace-aggregate-"));
    const originalDepth = config.gitDiscoveryDepth;
    try {
      await symlink(root, path.join(aggregate, "repo-a"), "dir");
      config.gitDiscoveryDepth = 1;
      const opened = await app.inject({ method: "POST", url: "/api/workspace/open", payload: { path: aggregate } });
      expect(opened.statusCode).toBe(200);

      const tree = await app.inject({ method: "GET", url: "/api/files/tree" });
      expect(tree.statusCode).toBe(200);
      const entries = tree.json().data as Array<{ name: string; gitTrackedState?: string; repositoryChangedFileCount?: number }>;
      expect(entries.find((entry) => entry.name === "repo-a")).toMatchObject({ gitTrackedState: "repository", repositoryChangedFileCount: 2 });
    } finally {
      config.gitDiscoveryDepth = originalDepth;
      await app.inject({ method: "POST", url: "/api/workspace/close" });
      await rm(aggregate, { recursive: true, force: true });
    }
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

  it("serves PNG files through the guarded raw preview endpoint", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await writeFile(path.join(root, "image.png"), png);
    const response = await app.inject({ method: "GET", url: "/api/files/raw?path=image.png" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(png);
  });

  it("serves worktree and committed PNG versions for Git image diff", async () => {
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const changed = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
    await writeFile(path.join(root, "tracked.png"), original);
    execFileSync("git", ["add", "tracked.png"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "add image"], { cwd: root });
    await writeFile(path.join(root, "tracked.png"), changed);
    const head = await app.inject({ method: "GET", url: "/api/git/image?source=head&path=tracked.png" });
    const worktree = await app.inject({ method: "GET", url: "/api/git/image?source=worktree&path=tracked.png" });
    expect(head.rawPayload).toEqual(original);
    expect(worktree.rawPayload).toEqual(changed);
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

  it("lists branches, protects dirty worktrees and switches local branches", async () => {
    execFileSync("git", ["branch", "feature/test"], { cwd: root });
    const branches = await app.inject({ method: "GET", url: "/api/git/branches" });
    expect(branches.json().data.some((branch: { name: string }) => branch.name === "feature/test")).toBe(true);
    await writeFile(path.join(root, "hello.txt"), "dirty\n");
    const blocked = await app.inject({ method: "POST", url: "/api/git/switch", payload: { name: "feature/test", kind: "local" } });
    expect(blocked.statusCode).toBe(409);
    execFileSync("git", ["restore", "hello.txt"], { cwd: root });
    const switched = await app.inject({ method: "POST", url: "/api/git/switch", payload: { name: "feature/test", kind: "local" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().data.workspace.git.branch).toBe("feature/test");
  });

  it("returns topological graph data with merge parents and decorations", async () => {
    const baseBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["switch", "-qc", "feature/graph"], { cwd: root });
    await writeFile(path.join(root, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "feature commit"], { cwd: root });
    execFileSync("git", ["switch", "-q", baseBranch], { cwd: root });
    await writeFile(path.join(root, "main.txt"), "main\n");
    execFileSync("git", ["add", "main.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "main commit"], { cwd: root });
    execFileSync("git", ["merge", "--no-ff", "-qm", "merge graph", "feature/graph"], { cwd: root });
    const graph = await app.inject({ method: "GET", url: "/api/git/graph?limit=100" });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().data.items.some((commit: { parents: string[] }) => commit.parents.length === 2)).toBe(true);
    expect(graph.json().data.items.some((commit: { decorations: unknown[] }) => commit.decorations.length > 0)).toBe(true);
  });
});
