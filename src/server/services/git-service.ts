import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DiffDocument, DiffFile, DiffScope, GitChangedFile, GitCommitDetail, GitCommitSummary, GitState, GitStatusSnapshot } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { WorkspaceService } from "./workspace-service.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const validHash = /^[0-9a-f]{4,64}$/i;

export class GitService {
  private revision = 0;
  private snapshot: GitStatusSnapshot | null = null;
  constructor(private workspace: WorkspaceService) {}

  private context() {
    const context = this.workspace.get();
    if (!context.gitRunner || !context.info.git) throw new AppError(503, "GIT_UNAVAILABLE", "当前工作区不是 Git 仓库");
    return { context, runner: context.gitRunner };
  }

  invalidate() { this.snapshot = null; }
  getRevision() { return this.revision; }

  async status(force = false): Promise<GitStatusSnapshot> {
    if (this.snapshot && !force) return this.snapshot;
    const { runner } = this.context();
    const raw = await runner.run(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
    const records = raw.toString("utf8").split("\0").filter(Boolean);
    const files: GitChangedFile[] = [];
    let branch: string | null = null;
    let head: string | null = null;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.startsWith("# branch.head ")) { const value = record.slice(14); branch = value === "(detached)" ? null : value; continue; }
      if (record.startsWith("# branch.oid ")) { const value = record.slice(13); head = value === "(initial)" ? null : value; continue; }
      if (record.startsWith("? ")) { files.push({ path: record.slice(2), indexStatus: "?", worktreeStatus: "?", categories: ["untracked"] }); continue; }
      if (record.startsWith("u ")) {
        const parts = record.split(" ");
        files.push({ path: parts.slice(10).join(" "), indexStatus: "U", worktreeStatus: "U", categories: ["conflicted"] });
        continue;
      }
      if (record.startsWith("1 ") || record.startsWith("2 ")) {
        const renamed = record.startsWith("2 ");
        const parts = record.split(" ");
        const xy = parts[1];
        const pathIndex = renamed ? 9 : 8;
        const filePath = parts.slice(pathIndex).join(" ");
        const oldPath = renamed ? records[++i] : undefined;
        const categories: GitChangedFile["categories"] = [];
        if (xy[0] !== ".") categories.push("staged");
        if (xy[1] !== ".") categories.push("unstaged");
        files.push({ path: filePath, oldPath, indexStatus: xy[0], worktreeStatus: xy[1], categories });
      }
    }
    const applyStats = async (args: string[], category: "staged" | "unstaged") => {
      const rows = (await runner.text(args, { allowFailure: true })).split("\n").filter(Boolean);
      for (const row of rows) {
        const [a, d, ...pathParts] = row.split("\t");
        const filePath = pathParts.join("\t").replace(/^.* => /, "").replace(/[{}]/g, "");
        const file = files.find((item) => item.path === filePath && item.categories.includes(category));
        if (!file) continue;
        if (a !== "-") file.additions = (file.additions ?? 0) + Number(a);
        if (d !== "-") file.deletions = (file.deletions ?? 0) + Number(d);
        if (a === "-" || d === "-") file.binary = true;
      }
    };
    await applyStats(["diff", "--numstat"], "unstaged");
    await applyStats(["diff", "--cached", "--numstat"], "staged");
    this.revision++;
    const counts = { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 };
    for (const file of files) for (const category of file.categories) counts[category]++;
    this.snapshot = { revision: this.revision, branch, head, detached: !branch && Boolean(head), clean: files.length === 0, files, counts };
    return this.snapshot;
  }

  async ignored(paths: string[]) {
    if (!paths.length) return new Set<string>();
    const { runner } = this.context();
    const output = await runner.text(["check-ignore", "--no-index", "-z", "--", ...paths], { allowFailure: true });
    return new Set(output.split("\0").filter(Boolean));
  }

  async fileState(relative: string): Promise<GitState> {
    const snapshot = await this.status();
    const matches = snapshot.files.filter((file) => file.path === relative || file.oldPath === relative);
    if (!matches.length) return null;
    const file = matches[0];
    if (file.categories.includes("conflicted")) return "conflicted";
    if (file.categories.includes("untracked")) return "untracked";
    const code = file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus;
    return code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
  }

  async history(cursor?: string, limit = 50) {
    const { runner } = this.context();
    const bounded = Math.max(1, Math.min(limit, 100));
    if (cursor && !validHash.test(cursor)) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
    const format = "%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1e";
    const logArgs = ["log", `--max-count=${bounded}`, `--format=${format}`];
    if (cursor) logArgs.push("--skip=1", cursor); else logArgs.push("HEAD");
    const text = await runner.text(logArgs, { allowFailure: true, timeoutMs: 30_000 });
    const commits = text.split("\x1e").map((r) => r.trim()).filter(Boolean).map((record): GitCommitSummary => {
      const [hash, shortHash, parents, subject, authorName, authorEmail, authoredAt, committedAt] = record.split("\x1f");
      return { hash, shortHash, parents: parents ? parents.split(" ") : [], subject, authorName, authorEmail, authoredAt, committedAt };
    });
    return { items: commits, nextCursor: commits.length === bounded ? commits.at(-1)!.hash : null, head: (await this.status()).head };
  }

  async commit(hash: string): Promise<GitCommitDetail> {
    if (!validHash.test(hash)) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
    const { runner } = this.context();
    const format = "%H%x1f%h%x1f%P%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI";
    const meta = (await runner.text(["show", "-s", `--format=${format}`, hash])).trim().split("\x1f");
    const nameStatus = (await runner.run(["diff-tree", "--root", "--no-commit-id", "-r", "-M", "--name-status", "-z", hash])).toString("utf8").split("\0").filter(Boolean);
    const files = this.parseNameStatus(nameStatus).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status }));
    const numstat = (await runner.text(["diff-tree", "--root", "--no-commit-id", "-r", "--numstat", hash])).trim().split("\n").filter(Boolean);
    let additions = 0, deletions = 0;
    for (const line of numstat) { const [a, d] = line.split("\t"); if (a !== "-") additions += Number(a); if (d !== "-") deletions += Number(d); }
    return { hash: meta[0], shortHash: meta[1], parents: meta[2] ? meta[2].split(" ") : [], subject: meta[3], body: meta[4], authorName: meta[5], authorEmail: meta[6], authoredAt: meta[7], committerName: meta[8], committerEmail: meta[9], committedAt: meta[10], files, additions, deletions };
  }

  private parseNameStatus(records: string[]) {
    const result: Array<{ code: string; status: DiffFile["status"]; path: string; oldPath?: string }> = [];
    for (let i = 0; i < records.length; i++) {
      const code = records[i];
      const letter = code[0];
      if (letter === "R" || letter === "C") { const oldPath = records[++i]; const filePath = records[++i]; result.push({ code, status: "renamed", path: filePath, oldPath }); }
      else { const filePath = records[++i]; result.push({ code, status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified", path: filePath }); }
    }
    return result;
  }

  private async readGit(runner: GitRunner, spec: string) {
    const buffer = await runner.run(["show", spec], { allowFailure: true });
    if (buffer.includes(0)) return { binary: true, text: undefined };
    return { binary: false, text: buffer.toString("utf8") };
  }

  async diff(scope: DiffScope, selectedPath?: string, hash?: string): Promise<DiffDocument> {
    const { context, runner } = this.context();
    let args: string[];
    let base: string;
    let target: string;
    let parent = "HEAD";
    if (scope === "working") { args = ["diff", "--name-status", "-z", "-M"]; base = "INDEX"; target = "WORKTREE"; }
    else if (scope === "staged") { args = ["diff", "--cached", "--name-status", "-z", "-M"]; base = "HEAD"; target = "INDEX"; }
    else if (scope === "all") { args = ["diff", "HEAD", "--name-status", "-z", "-M"]; base = "HEAD"; target = "WORKTREE"; }
    else {
      if (!hash || !validHash.test(hash)) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
      const detail = await this.commit(hash);
      parent = detail.parents[0] ?? EMPTY_TREE;
      args = ["diff", parent, hash, "--name-status", "-z", "-M"];
      base = parent; target = hash;
    }
    if (selectedPath) args.push("--", selectedPath);
    const records = (await runner.run(args, { allowFailure: scope !== "commit" })).toString("utf8").split("\0").filter(Boolean);
    const changes = this.parseNameStatus(records);
    if (scope === "working" || scope === "all") {
      const untracked = (await this.status()).files.filter((f) => f.categories.includes("untracked") && (!selectedPath || f.path === selectedPath));
      for (const file of untracked) if (!changes.some((c) => c.path === file.path)) changes.push({ code: "A", status: "added", path: file.path });
    }
    const files: DiffFile[] = [];
    let truncated = false;
    for (const change of changes) {
      let oldSide = { binary: false, text: "" as string | undefined };
      let newSide = { binary: false, text: "" as string | undefined };
      const oldPath = change.oldPath ?? change.path;
      if (change.status !== "added") {
        if (scope === "working") oldSide = await this.readGit(runner, `:${oldPath}`);
        else if (scope === "commit") oldSide = await this.readGit(runner, `${parent}:${oldPath}`);
        else oldSide = await this.readGit(runner, `HEAD:${oldPath}`);
      }
      if (change.status !== "deleted") {
        if (scope === "staged") newSide = await this.readGit(runner, `:${change.path}`);
        else if (scope === "commit") newSide = await this.readGit(runner, `${hash}:${change.path}`);
        else {
          const absolute = path.join(context.info.rootPath, change.path);
          const buffer = await readFile(absolute).catch(() => Buffer.alloc(0));
          newSide = buffer.includes(0) ? { binary: true, text: undefined } : { binary: false, text: buffer.toString("utf8") };
        }
      }
      const binary = oldSide.binary || newSide.binary;
      const max = 5 * 1024 * 1024;
      const tooLarge = (oldSide.text?.length ?? 0) + (newSide.text?.length ?? 0) > max;
      truncated ||= tooLarge;
      files.push({ path: change.path, oldPath: change.oldPath, status: binary ? "binary" : change.status, oldText: binary || tooLarge ? undefined : oldSide.text, newText: binary || tooLarge ? undefined : newSide.text, truncated: tooLarge });
    }
    return { id: createHash("sha1").update(`${scope}:${hash ?? ""}:${selectedPath ?? ""}:${this.revision}`).digest("hex"), scope, base, target, generatedAt: new Date().toISOString(), gitRevision: this.revision, truncated, files };
  }
}
