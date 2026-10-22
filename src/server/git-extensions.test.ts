import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { GitRunner } from "./infrastructure/git-runner.js";
import { RepositoryTasks } from "./services/repository-tasks.js";
import type { GitHistoryPage, WorktreeOverview } from "../shared/contracts.js";

let base: string, root: string, main: string, linked: string, producer: string, remote: string;
let authServer: Server | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const configure = (cwd: string) => { git(cwd, "config", "user.name", "Tester"); git(cwd, "config", "user.email", "test@example.com"); };
const headers = { "x-code-workspace-session": "A" };
async function call(url: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", payload?: unknown, session = headers) {
  return app.inject({ url, method, headers: session, ...(payload === undefined ? {} : { payload }) });
}
async function overview(): Promise<WorktreeOverview> { const r = await call("/api/git/worktrees"); expect(r.statusCode).toBe(200); return r.json().data; }
async function commit(cwd: string, subject: string, files: Record<string, string>) { for (const [name, value] of Object.entries(files)) await writeFile(path.join(cwd, name), value); git(cwd, "add", "."); git(cwd, "commit", "-qm", subject); return git(cwd, "rev-parse", "HEAD"); }

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), "cw-git-extensions-")));
  root = path.join(base, "workspace"); await mkdir(root);
  main = path.join(root, "main checkout"); linked = path.join(root, "关联 工作区");
  producer = path.join(base, "producer"); remote = path.join(base, "remote.git");
  git(base, "init", "--bare", "-q", "--initial-branch=trunk", remote);
  git(base, "clone", "-q", remote, main); configure(main);
  await commit(main, "root commit", { "a.txt": "one\n", "b.txt": "two\n", ".gitignore": "ignored/\n" });
  git(main, "push", "-qu", "origin", "trunk"); git(main, "remote", "set-head", "origin", "-a");
  git(main, "worktree", "add", "-qb", "feat/local", linked);
  git(base, "clone", "-q", remote, producer); configure(producer);
  await symlink(linked, path.join(root, "alias"));
  app = await buildApp({ disableAuth: true });
  await call("/api/workspace/open", "POST", { path: root });
});
afterEach(async () => { if (authServer) { await new Promise<void>(resolve => authServer!.close(() => resolve())); authServer = undefined; } vi.restoreAllMocks(); await app.close(); await rm(base, { recursive: true, force: true }); });

describe("B-009 / B-010 stage A", () => {
  it("WT-11: returns shared remote addresses without merging independent clones or exposing credentials", async () => {
    const independent = path.join(root, "independent"); git(base, "clone", "-q", remote, independent);
    const address = "https://secret-user:secret-token@example.com/team/project.git?access_token=query-secret#fragment-secret";
    for (const cwd of [main, independent]) git(cwd, "remote", "set-url", "origin", address);
    git(main, "config", "--add", "remote.origin.url", "ssh://git@example.net/team/mirror.git");
    git(main, "remote", "set-url", "--push", "origin", "https://push-user:push-secret@push.example.com/team/project.git?token=push-query");
    git(main, "remote", "add", "upstream.backup", "git@example.org:team/upstream.git");
    await call("/api/workspace/open", "POST", { path: root });
    const data = await overview();
    expect(data.groups).toHaveLength(2);
    const original = data.groups.find(g => g.worktrees.some(w => w.path === main))!;
    const clone = data.groups.find(g => g.worktrees.some(w => w.path === independent))!;
    expect(original.worktrees).toHaveLength(2);
    expect(original.repositoryGroupId).not.toBe(clone.repositoryGroupId);
    expect(original.remote.primaryUrl).toBe("https://example.com/team/project.git");
    expect(clone.remote.primaryUrl).toBe(original.remote.primaryUrl);
    expect(original.remote.remotes).toEqual(expect.arrayContaining([
      { name: "origin", fetchUrls: ["https://example.com/team/project.git", "ssh://example.net/team/mirror.git"], pushUrls: ["https://push.example.com/team/project.git"] },
      { name: "upstream.backup", fetchUrls: ["git@example.org:team/upstream.git"], pushUrls: ["git@example.org:team/upstream.git"] }
    ]));
    const serialized = JSON.stringify(data);
    for (const secret of ["secret-user", "secret-token", "query-secret", "fragment-secret", "push-user", "push-secret", "push-query"]) expect(serialized).not.toContain(secret);
    expect(git(main, "config", "--get-all", "remote.origin.url").split("\n")[0]).toBe(address);
  });

  it("WT-11: falls back without origin and distinguishes missing remotes from address query errors", async () => {
    git(main, "remote", "rename", "origin", "mirror.name");
    expect((await overview()).groups[0].remote).toMatchObject({ primaryName: "mirror.name", primaryUrl: remote });
    git(main, "remote", "remove", "mirror.name");
    expect((await overview()).groups[0].remote).toEqual({ primaryName: null, primaryUrl: null, remotes: [] });
    const original = GitRunner.prototype.run;
    vi.spyOn(GitRunner.prototype, "run").mockImplementation(function (this: GitRunner, args, options) {
      if (args[0] === "config") return Promise.reject(new Error("private diagnostic"));
      return original.call(this, args, options);
    });
    const group = (await overview()).groups[0];
    expect(group.remote.error).toBe("Git 地址读取失败，请刷新重试");
    expect(group.worktrees.every(w => w.status?.clean)).toBe(true);
  });

  it("GG-08: compares ancestry against current HEAD and fetched remotes, including undecorated commits", async () => {
    const shared = git(main, "rev-parse", "HEAD");
    const local = await commit(main, "local only", { "a.txt": "local\n" });
    const remoteAncestor = await commit(producer, "remote ancestor", { "a.txt": "remote one\n" });
    const remoteTip = await commit(producer, "remote tip", { "a.txt": "remote two\n" });
    git(producer, "push", "-q", "origin", "trunk"); git(main, "fetch", "-q", "origin");
    const other = await commit(linked, "other local worktree", { "b.txt": "other\n" });
    const mainId = (await overview()).groups[0].worktrees.find(w => w.path === main)!.repositoryId;
    await call("/api/git/repository/select", "POST", { repositoryId: mainId });
    const page: GitHistoryPage = (await call("/api/git/graph")).json().data;
    expect(page.head).toBe(local);
    expect(page.comparison).toEqual({ upstream: "refs/remotes/origin/trunk", ahead: 1, behind: 2 });
    expect(page.items.find(c => c.hash === local)).toMatchObject({ inCurrentHistory: true, inRemoteHistory: false });
    expect(page.items.find(c => c.hash === shared)).toMatchObject({ inCurrentHistory: true, inRemoteHistory: true });
    expect(page.items.find(c => c.hash === remoteAncestor)).toMatchObject({ decorations: [], inCurrentHistory: false, inRemoteHistory: true });
    expect(page.items.find(c => c.hash === remoteTip)).toMatchObject({ inCurrentHistory: false, inRemoteHistory: true });
    expect(page.items.find(c => c.hash === other)).toMatchObject({ inCurrentHistory: false, inRemoteHistory: false });
    const linkedId = (await overview()).groups[0].worktrees.find(w => w.path === linked)!.repositoryId;
    await call("/api/git/repository/select", "POST", { repositoryId: linkedId });
    const switched: GitHistoryPage = (await call("/api/git/graph")).json().data;
    expect(switched.graphRevision).not.toBe(page.graphRevision);
    expect(switched.items.find(c => c.hash === other)?.inCurrentHistory).toBe(true);
  });

  it("GG-08: absent remote refs and detached upstream remain unknown rather than reported as published", async () => {
    git(main, "switch", "--detach", "-q"); git(main, "remote", "remove", "origin");
    const mainId = (await overview()).groups[0].worktrees.find(w => w.path === main)!.repositoryId;
    await call("/api/git/repository/select", "POST", { repositoryId: mainId });
    const page: GitHistoryPage = (await call("/api/git/graph")).json().data;
    expect(page.comparison).toEqual({ upstream: null, ahead: null, behind: null });
    expect(page.items[0]).toMatchObject({ inCurrentHistory: true, inRemoteHistory: null });
    expect(page.items[0].decorations).toContainEqual({ type: "head", name: "HEAD" });
  });

  it("AC-WT-01/02/04: groups common-dir, deduplicates aliases and preserves independent status", async () => {
    git(base, "clone", "-q", remote, path.join(root, "independent"));
    await call("/api/workspace/open", "POST", { path: root });
    await writeFile(path.join(main, "a.txt"), "staged\n"); git(main, "add", "a.txt"); await writeFile(path.join(main, "a.txt"), "also unstaged\n");
    await writeFile(path.join(linked, "new.txt"), "untracked\n");
    const external = path.join(base, "external"); git(main, "worktree", "add", "-qb", "outside", external); git(main, "worktree", "lock", "--reason", "保留", external);
    const missing = path.join(base, "missing"); git(main, "worktree", "add", "-qb", "gone", missing); await rm(missing, { recursive: true });
    const data = await overview(); expect(data.groups).toHaveLength(2);
    const group = data.groups.find(g => g.worktrees.some(w => w.path === main))!;
    expect(group.worktrees).toHaveLength(4); expect(group.changedFileCount).toBe(2);
    expect(group.worktrees.find(w => w.path === main)).toMatchObject({ main: true, status: { clean: false, counts: { staged: 1, unstaged: 1 } } });
    expect(group.worktrees.find(w => w.path === linked)).toMatchObject({ main: false, status: { counts: { untracked: 1 } }, upstream: null });
    expect(group.worktrees.find(w => w.path === external)).toMatchObject({ inWorkspace: false, locked: "保留" });
    expect(group.worktrees.find(w => w.path === missing)).toMatchObject({ missing: true, status: null });
    const outsideId = group.worktrees.find(w => w.path === external)!.worktreeId;
    expect((await call(`/api/git/status?worktreeId=${outsideId}`)).statusCode).toBe(503);
    expect((await call(`/api/git/worktrees/${outsideId}/removal-preview`, "POST")).json().data.reasons.join(" ")).toContain("工作区外");
    const limited = config.gitStatusLimit; config.gitStatusLimit = 0;
    try { expect((await overview()).groups.every(g => g.worktrees.every(w => w.status === null))).toBe(true); } finally { config.gitStatusLimit = limited; }
    await call("/api/workspace/open", "POST", { path: linked });
    expect((await overview()).groups[0].worktrees.find(w => w.path === main)?.main).toBe(true);
  });

  it("AC-GG-01/06: full fetch overrides narrow refspec, handles partial failure and prunes only remote refs", async () => {
    git(main, "config", "credential.helper", "");
    const oldConfig = "+refs/heads/trunk:refs/remotes/origin/trunk"; git(main, "config", "remote.origin.fetch", oldConfig);
    git(producer, "switch", "-qc", "feat/remote"); const hash = await commit(producer, "remote update", { "a.txt": "remote\n", "new.txt": "new\n" });
    git(producer, "tag", "release/v1"); git(producer, "push", "-q", "origin", "feat/remote", "--tags");
    git(main, "branch", "keep-local"); git(main, "tag", "keep-tag"); authServer = createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }); res.end("authentication required"); });
    await new Promise<void>(resolve => authServer!.listen(0, "127.0.0.1", resolve));
    const address = authServer.address() as { port: number };
    git(main, "remote", "add", "broken", `http://secret:credential@127.0.0.1:${address.port}/private`);
    const before = git(main, "rev-parse", "HEAD"); const original = await readFile(path.join(main, "a.txt"), "utf8");
    const group = (await overview()).groups[0];
    const [one, two] = await Promise.all([call("/api/git/fetch", "POST", { repositoryGroupId: group.repositoryGroupId }), call("/api/git/fetch", "POST", { repositoryGroupId: group.repositoryGroupId })]);
    expect(one.json().data.startedAt).toBe(two.json().data.startedAt);
    expect(one.json().data.remotes.find((r: { name: string }) => r.name === "origin").success).toBe(true);
    expect(one.json().data.remotes.find((r: { name: string }) => r.name === "broken").success).toBe(false);
    expect(one.body).not.toContain("credential"); expect(one.body).not.toContain("secret");
    expect(git(main, "rev-parse", "refs/remotes/origin/feat/remote")).toBe(hash);
    expect(git(main, "config", "remote.origin.fetch")).toBe(oldConfig);
    expect(git(main, "rev-parse", "HEAD")).toBe(before); expect(await readFile(path.join(main, "a.txt"), "utf8")).toBe(original);
    const diff = await call(`/api/git/diff/commits/${hash}`); expect(diff.json().data.files).toHaveLength(2);
    git(producer, "push", "-q", "origin", "--delete", "feat/remote");
    await call("/api/git/fetch", "POST", { repositoryGroupId: group.repositoryGroupId });
    expect(git(main, "for-each-ref", "refs/remotes/origin/feat/remote")).toBe("");
    expect(git(main, "rev-parse", "keep-local")).toBe(before); expect(git(main, "rev-parse", "keep-tag")).toBe(before);
    const history = await call("/api/git/graph"); expect(history.statusCode).toBe(200);
  }, 30000);

  it("AC-GG-02/03/04: paginates >200 commits with exact ref types, detached HEAD, scopes and revision resets", async () => {
    const rootHash = git(main, "rev-parse", "HEAD");
    let input = "";
    for (let i = 1; i <= 225; i++) { const subject = `history ${i}`; input += `commit refs/heads/codex/long\nmark :${i}\ncommitter Tester <test@example.com> ${1600000000 + i} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nfrom ${i === 1 ? rootHash : `:${i - 1}`}\n\n`; }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: main, input });
    const tree = git(main, "rev-parse", `${rootHash}^{tree}`);
    const side = git(main, "commit-tree", tree, "-p", rootHash, "-m", "side branch");
    git(main, "update-ref", "refs/heads/fix/side", side);
    const merged = git(main, "commit-tree", tree, "-p", git(main, "rev-parse", "codex/long"), "-p", side, "-m", "merge long history");
    git(main, "update-ref", "refs/heads/codex/long", merged);
    git(main, "tag", "tag/slash", "codex/long"); git(main, "tag", "-am", "annotated tag", "release/annotated", "codex/long"); git(main, "update-ref", "refs/remotes/upstream/topic", "codex/long");
    git(linked, "switch", "--detach", "-q"); const detached = await commit(linked, "detached only", { "a.txt": "detached\n" });
    await writeFile(path.join(main, "a.txt"), "stash\n"); git(main, "stash", "push", "-qm", "excluded stash"); const stash = git(main, "rev-parse", "refs/stash");
    let page: GitHistoryPage = (await call("/api/git/graph?limit=100")).json().data;
    const all = [...page.items];
    while (page.nextCursor !== null) { page = (await call(`/api/git/graph?limit=100&cursor=${page.nextCursor}&graphRevision=${page.graphRevision}`)).json().data; all.push(...page.items); }
    expect(all.length).toBe(229); expect(new Set(all.map(c => c.hash)).size).toBe(229); expect(all.some(c => c.hash === detached)).toBe(true); expect(all.some(c => c.hash === stash)).toBe(false);
    const cli = git(main, "rev-list", "refs/heads/trunk", "refs/heads/feat/local", "refs/heads/codex/long", "refs/remotes/origin/trunk", "refs/remotes/upstream/topic", "refs/tags/tag/slash", detached).split("\n");
    expect(all.map(c => c.hash).sort()).toEqual(cli.sort());
    expect(all.find(c => c.hash === merged)?.parents).toHaveLength(2);
    const top = all.find(c => c.decorations.some(d => d.name === "codex/long"))!;
    expect(top.decorations).toEqual(expect.arrayContaining([{ type: "local", name: "codex/long" }, { type: "remote", name: "upstream/topic" }, { type: "tag", name: "tag/slash" }]));
    const mainId = (await overview()).groups[0].worktrees.find(w => w.path === main)!.repositoryId;
    await call("/api/git/repository/select", "POST", { repositoryId: mainId });
    expect((await call("/api/git/graph?scope=current")).json().data.items).toHaveLength(1);
    expect((await call("/api/git/history?scope=ref&ref=refs%2Fheads%2Fcodex%2Flong&limit=200")).json().data.total).toBe(228);
    expect((await call("/api/git/graph?scope=ref&ref=refs%2Fstash")).statusCode).toBe(404);
    git(main, "branch", "fix/new-ref");
    expect((await call(`/api/git/graph?cursor=100&graphRevision=${page.graphRevision}`)).statusCode).toBe(409);
  }, 30000);

  it("AC-GG-05: root and merge details match full per-file diffs against first parent", async () => {
    const rootHash = git(main, "rev-parse", "HEAD");
    const detail = (await call(`/api/git/commits/${rootHash}`)).json().data;
    expect(detail.files).toHaveLength(3); expect((await call(`/api/git/diff/commits/${rootHash}`)).json().data.files).toHaveLength(3);
    await commit(linked, "two files", { "a.txt": "feature\n", "b.txt": "feature two\n" });
    await commit(main, "trunk change", { "extra.txt": "trunk\n" }); git(main, "merge", "--no-ff", "-qm", "merge feature", "feat/local");
    const hash = git(main, "rev-parse", "HEAD");
    const merged = (await call(`/api/git/commits/${hash}`)).json().data;
    const diff = (await call(`/api/git/diff/commits/${hash}`)).json().data;
    expect(merged.parents).toHaveLength(2); expect(merged.files.map((f: { path: string }) => f.path).sort()).toEqual(["a.txt", "b.txt"]); expect(diff.files).toHaveLength(2);
    for (const file of merged.files) expect((await call(`/api/git/diff/commits/${hash}?path=${file.path}`)).json().data.files).toHaveLength(1);
  });

  it("AC-WT-05/07: preview blocks ignored/unsaved/session/locked/dirty/detached roots; generic operations cannot bypass", async () => {
    const data = await overview(), group = data.groups[0], target = group.worktrees.find(w => w.path === linked)!;
    const mainRepo = group.worktrees.find(w => w.path === main)!;
    await call("/api/git/repository/select", "POST", { repositoryId: mainRepo.repositoryId });
    expect((await call(`/api/git/worktrees/${mainRepo.worktreeId}/removal-preview`, "POST")).json().data.reasons.join(" ")).toContain("主 worktree");
    const preview = () => call(`/api/git/worktrees/${target.worktreeId}/removal-preview`, "POST");
    expect((await preview()).json().data.allowed).toBe(true);
    await mkdir(path.join(linked, "ignored")); await writeFile(path.join(linked, "ignored", "data"), "do not lose");
    expect((await preview()).json().data.reasons.join(" ")).toContain("忽略"); await rm(path.join(linked, "ignored"), { recursive: true });
    await call("/api/git/editor-state", "POST", { workspaceId: (await call("/api/workspace")).json().data.id, paths: ["alias/a.txt"], dirtyPaths: ["alias/a.txt"] });
    expect((await preview()).json().data.unsavedCount).toBe(1);
    await call("/api/git/editor-state", "POST", { workspaceId: (await call("/api/workspace")).json().data.id, paths: [], dirtyPaths: [] });
    await call("/api/workspace/open", "POST", { path: linked }, { "x-code-workspace-session": "B" });
    expect((await preview()).json().data.otherSessionCount).toBe(1);
    await call("/api/workspace/close", "POST", undefined, { "x-code-workspace-session": "B" });
    git(main, "worktree", "lock", linked); expect((await preview()).json().data.reasons.join(" ")).toContain("锁定"); git(main, "worktree", "unlock", linked);
    await writeFile(path.join(linked, "a.txt"), "dirty\n"); expect((await preview()).json().data.allowed).toBe(false); git(linked, "restore", ".");
    git(linked, "switch", "--detach", "-q"); await commit(linked, "unreferenced detached", { "a.txt": "detached\n" });
    expect((await preview()).json().data.reasons.join(" ")).toContain("detached");
    const protectedPath = path.relative(root, linked);
    expect((await call(`/api/files?path=${encodeURIComponent(protectedPath)}&recursive=true&confirmed=true`, "DELETE")).statusCode).toBe(409);
    expect((await call("/api/files/rename", "PATCH", { from: protectedPath, to: "renamed" })).statusCode).toBe(409);
    expect((await call("/api/files?path=alias&confirmed=true", "DELETE")).statusCode).toBe(200);
    expect(await readFile(path.join(linked, "a.txt"), "utf8")).toBe("detached\n");
  });

  it("AC-INT-01: metadata watcher notices external refs and registry changes; session scope remains isolated", async () => {
    const group = (await overview()).groups[0];
    const second = { "x-code-workspace-session": "B" };
    await call("/api/workspace/open", "POST", { path: linked }, second);
    const bRepo = (await call("/api/workspace", "GET", undefined, second)).json().data.git;
    expect((await call(`/api/git/status?repositoryId=${group.worktrees.find(w => w.path === main)!.repositoryId}`, "GET", undefined, second)).statusCode).toBe(503);
    const workspaceId = (await call("/api/workspace")).json().data.id;
    const socket = await app.injectWS(`/api/events?workspaceId=${workspaceId}&sessionId=A`);
    const events: string[] = []; socket.on("message", data => events.push(data.toString()));
    await new Promise(resolve => setTimeout(resolve, 300));
    git(main, "branch", "external/ref");
    await vi.waitFor(() => expect(events.some(e => e.includes("git.statusChanged"))).toBe(true), { timeout: 6000 });
    const another = path.join(root, "newly registered"); git(main, "worktree", "add", "-qb", "external/worktree", another);
    expect((await overview()).groups[0].worktrees.some(w => w.path === another)).toBe(true);
    expect((await call("/api/workspace", "GET", undefined, second)).json().data.git.id).toBe(bRepo.id);
    socket.close();
  });

  it("AC-WT-02/04/07: conflicts, upstream metrics, registry limits and shallow boundaries remain explicit", async () => {
    await commit(main, "trunk divergent", { "a.txt": "trunk conflict\n" });
    await commit(linked, "feature divergent", { "a.txt": "feature conflict\n" });
    try { git(linked, "merge", "trunk"); } catch { /* expected conflict */ }
    const initial = await overview(), group = initial.groups[0];
    expect(group.worktrees.find(w => w.path === main)?.upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect(group.worktrees.find(w => w.path === linked)?.status?.counts.conflicted).toBe(1);
    const beforeLimit = config.gitWorktreeLimit; config.gitWorktreeLimit = 1;
    try {
      expect((await overview()).groups[0].truncated).toBe(true);
      expect((await call("/api/git/graph")).statusCode).toBe(503);
    } finally { config.gitWorktreeLimit = beforeLimit; }
    const shallow = path.join(root, "shallow"); git(base, "clone", "-q", "--depth=1", `file://${remote}`, shallow);
    await call("/api/workspace/open", "POST", { path: shallow });
    expect((await call("/api/git/graph")).json().data.shallow).toBe(true);
  });

  it("AC-INT-01: repeated concurrent registry refresh cannot resurrect stale registry; image query carries session", async () => {
    const { rootPath, id: workspaceId } = (await call("/api/workspace")).json().data;
    const extra = path.join(rootPath, "registered later");
    const reads = [call("/api/workspace"), call("/api/git/graph"), call("/api/git/worktrees")];
    git(main, "worktree", "add", "-qb", "later", extra);
    await Promise.all(reads);
    expect((await overview()).groups[0].worktrees.some(w => w.path === extra)).toBe(true);
    const repo = (await call("/api/workspace")).json().data.repositories.find((r: { repositoryRoot: string }) => r.repositoryRoot === extra);
    expect(repo).toBeDefined();
    await writeFile(path.join(main, "preview.png"), Buffer.from("image A"));
    await writeFile(path.join(linked, "preview.png"), Buffer.from("image B"));
    await call("/api/workspace/open", "POST", { path: linked }, { "x-code-workspace-session": "B" });
    expect((await app.inject({ url: "/api/files/raw?sessionId=B&path=preview.png" })).body).toBe("image B");
    expect((await app.inject({ url: "/api/files/raw?sessionId=A&path=main%20checkout%2Fpreview.png" })).body).toBe("image A");
    expect((await call("/api/workspace")).json().data.id).toBe(workspaceId);
    expect((await call("/api/files/tree?path=" + encodeURIComponent(path.basename(linked)))).json().data.find((f: { name: string }) => f.name === "a.txt").gitTrackedState).toBe("tracked");
  });

  it("AC-GG-06: timeout is bounded and duplicate fetch tasks share a single execution", async () => {
    const tasks = new RepositoryTasks(), runner = new GitRunner(main);
    vi.spyOn(runner, "run").mockImplementation(async args => {
      if (args[0] === "remote") return Buffer.from("origin\n");
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error("authentication https://secret:credential@example.com");
    });
    const [a, b] = await Promise.all([tasks.fetch("same", runner), tasks.fetch("same", runner)]);
    expect(a).toBe(b); expect(a.remotes[0].success).toBe(false); expect(JSON.stringify(a)).not.toContain("credential");
    expect(runner.run).toHaveBeenCalledTimes(2);
    const actualRunner = new GitRunner(main);
    await expect(actualRunner.run(["-c", "alias.slow=!sleep 2", "slow"], { timeoutMs: 20 })).rejects.toMatchObject({ code: "GIT_TIMEOUT" });

  });
});
