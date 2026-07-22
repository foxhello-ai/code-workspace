import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DiffDocument, DiffFile, DiffScope, GitBranchInfo, GitChangedFile, GitCommitDetail, GitCommitSummary, GitGraphCommit, GitState, GitStatusSnapshot } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { WorkspaceService } from "./workspace-service.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const validHash = /^[0-9a-f]{4,64}$/i;

export class GitService {
  private revisions = new Map<string, number>();
  private snapshots = new Map<string, GitStatusSnapshot>();
  constructor(private workspace: WorkspaceService) {}

  private context(repositoryId?: string) {
    return this.workspace.getRepository(repositoryId);
  }

  invalidate(repositoryId?: string) { repositoryId ? this.snapshots.delete(repositoryId) : this.snapshots.clear(); }
  getRevision(repositoryId?: string) {
    const repository = repositoryId ? this.workspace.get().info.repositories.find((item) => item.id === repositoryId) : this.workspace.get().info.git;
    return repository ? this.revisions.get(repository.id) ?? 0 : 0;
  }

  async status(force = false, repositoryId?: string): Promise<GitStatusSnapshot> {
    const { repository, runner } = this.context(repositoryId);
    const cached = this.snapshots.get(repository.id);
    if (cached && !force) return cached;
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
    const revision = (this.revisions.get(repository.id) ?? 0) + 1;
    this.revisions.set(repository.id, revision);
    const counts = { conflicted: 0, staged: 0, unstaged: 0, untracked: 0 };
    for (const file of files) for (const category of file.categories) counts[category]++;
    const snapshot = { repositoryId: repository.id, revision, branch, head, detached: !branch && Boolean(head), clean: files.length === 0, files, counts };
    this.snapshots.set(repository.id, snapshot);
    return snapshot;
  }

  async ignored(paths: string[], repositoryId?: string) {
    if (!paths.length) return new Set<string>();
    const { runner } = this.context(repositoryId);
    const output = await runner.text(["check-ignore", "--no-index", "-z", "--", ...paths], { allowFailure: true });
    return new Set(output.split("\0").filter(Boolean));
  }

  async tracked(paths: string[], repositoryId?: string) {
    if (!paths.length) return new Set<string>();
    const { runner } = this.context(repositoryId);
    const output = await runner.text(["ls-files", "-z", "--cached", "--", ...paths], { allowFailure: true });
    return new Set(output.split("\0").filter(Boolean));
  }

  async branches(repositoryId?: string) {
    const { runner } = this.context(repositoryId);
    const format = "%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00";
    const raw = await runner.text(["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"]);
    const fields = raw.split("\0");
    const items: GitBranchInfo[] = [];
    for (let index = 0; index + 4 < fields.length; index += 5) {
      const fullName = fields[index].replace(/^\n+/, "");
      if (!fullName || fullName.endsWith("/HEAD")) continue;
      const shortName = fields[index + 1];
      const kind = fullName.startsWith("refs/remotes/") ? "remote" : "local";
      items.push({ name: shortName, fullName, kind, target: fields[index + 2], current: fields[index + 3].trim() === "*", upstream: fields[index + 4] || undefined });
    }
    return items.sort((a, b) => Number(b.current) - Number(a.current) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  async switchBranch(name: string, kind: "local" | "remote", allowDirty = false, repositoryId?: string) {
    const { repository, runner } = this.context(repositoryId);
    const branches = await this.branches(repository.id);
    const target = branches.find((branch) => branch.name === name && branch.kind === kind);
    if (!target) throw new AppError(404, "BRANCH_NOT_FOUND", "分支不存在或已发生变化");
    const before = await this.status(true, repository.id);
    if (!before.clean && !allowDirty) throw new AppError(409, "GIT_WORKTREE_DIRTY", "工作区存在未提交修改，确认保留修改后才能切换", { files: before.files.length });
    if (target.current) return { workspace: this.workspace.get().info, status: before };
    if (kind === "local") await runner.run(["switch", "--", target.name], { write: true, timeoutMs: 30_000 });
    else {
      const localName = target.name.includes("/") ? target.name.slice(target.name.indexOf("/") + 1) : target.name;
      const localExists = branches.some((branch) => branch.kind === "local" && branch.name === localName);
      if (localExists) await runner.run(["switch", "--", localName], { write: true, timeoutMs: 30_000 });
      else await runner.run(["switch", "--track", target.name], { write: true, timeoutMs: 30_000 });
    }
    this.invalidate(repository.id);
    const workspace = await this.workspace.refreshGitInfo();
    const status = await this.status(true, repository.id);
    return { workspace, status };
  }

  async graph(cursor = 0, limit = 100, repositoryId?: string) {
    const { repository, runner } = this.context(repositoryId);
    const skip = Math.max(0, cursor);
    const bounded = Math.max(1, Math.min(limit, 200));
    const format = "%H%x1f%h%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%D%x1e";
    const text = await runner.text(["log", "--all", "--topo-order", "--date-order", `--skip=${skip}`, `--max-count=${bounded}`, `--format=${format}`], { allowFailure: true, timeoutMs: 30_000 });
    const items = text.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record): GitGraphCommit => {
      const [hash, shortHash, parents, subject, authorName, authorEmail, authoredAt, committedAt, decorationText = ""] = record.split("\x1f");
      const decorations = decorationText.split(", ").map((item) => item.trim()).filter(Boolean).map((item) => {
        if (item.startsWith("HEAD -> ")) return { type: "head" as const, name: item.slice(8) };
        if (item.startsWith("tag: ")) return { type: "tag" as const, name: item.slice(5) };
        if (item.startsWith("origin/") || item.includes("/")) return { type: "remote" as const, name: item };
        return { type: "local" as const, name: item };
      });
      return { hash, shortHash, parents: parents ? parents.split(" ") : [], subject, authorName, authorEmail, authoredAt, committedAt, decorations };
    });
    return { items, nextCursor: items.length === bounded ? skip + bounded : null, head: (await this.status(false, repository.id)).head };
  }

  async fileState(relative: string, repositoryId?: string): Promise<GitState> {
    const snapshot = await this.status(false, repositoryId);
    const matches = snapshot.files.filter((file) => file.path === relative || file.oldPath === relative);
    if (!matches.length) return null;
    const file = matches[0];
    if (file.categories.includes("conflicted")) return "conflicted";
    if (file.categories.includes("untracked")) return "untracked";
    const code = file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus;
    return code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
  }

  async history(cursor?: string, limit = 50, repositoryId?: string) {
    const { repository, runner } = this.context(repositoryId);
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
    return { items: commits, nextCursor: commits.length === bounded ? commits.at(-1)!.hash : null, head: (await this.status(false, repository.id)).head };
  }

  async commit(hash: string, repositoryId?: string): Promise<GitCommitDetail> {
    if (!validHash.test(hash)) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
    const { runner } = this.context(repositoryId);
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

  async image(source: "worktree" | "index" | "head" | "commit", filePath: string, hash?: string, repositoryId?: string) {
    const normalized = filePath.replaceAll("\\", "/");
    if (!normalized || path.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..") || normalized === ".git" || normalized.startsWith(".git/")) throw new AppError(400, "INVALID_PATH", "图片路径无效");
    const { repository, runner } = this.context(repositoryId);
    let buffer: Buffer;
    if (source === "worktree") {
      buffer = await readFile(path.join(repository.repositoryRoot, normalized));
    } else {
      if (source === "commit" && (!hash || !validHash.test(hash))) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
      const spec = source === "index" ? `:${normalized}` : source === "head" ? `HEAD:${normalized}` : `${hash}:${normalized}`;
      buffer = await runner.run(["show", spec], { allowFailure: true });
    }
    if (!buffer.length) throw new AppError(404, "IMAGE_VERSION_NOT_FOUND", "该版本中不存在此图片");
    if (buffer.length > 25 * 1024 * 1024) throw new AppError(413, "FILE_TOO_LARGE", "图片超过 25 MiB 预览限制");
    return buffer;
  }

  async diff(scope: DiffScope, selectedPath?: string, hash?: string, repositoryId?: string): Promise<DiffDocument> {
    const { repository, runner } = this.context(repositoryId);
    let args: string[];
    let base: string;
    let target: string;
    let parent = "HEAD";
    if (scope === "working") { args = ["diff", "--name-status", "-z", "-M"]; base = "INDEX"; target = "WORKTREE"; }
    else if (scope === "staged") { args = ["diff", "--cached", "--name-status", "-z", "-M"]; base = "HEAD"; target = "INDEX"; }
    else if (scope === "all") { args = ["diff", "HEAD", "--name-status", "-z", "-M"]; base = "HEAD"; target = "WORKTREE"; }
    else {
      if (!hash || !validHash.test(hash)) throw new AppError(400, "INVALID_REVISION", "提交标识无效");
      const detail = await this.commit(hash, repository.id);
      parent = detail.parents[0] ?? EMPTY_TREE;
      args = ["diff", parent, hash, "--name-status", "-z", "-M"];
      base = parent; target = hash;
    }
    if (selectedPath) args.push("--", selectedPath);
    const records = (await runner.run(args, { allowFailure: scope !== "commit" })).toString("utf8").split("\0").filter(Boolean);
    const changes = this.parseNameStatus(records);
    if (scope === "working" || scope === "all") {
      const untracked = (await this.status(false, repository.id)).files.filter((f) => f.categories.includes("untracked") && (!selectedPath || f.path === selectedPath));
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
          const absolute = path.join(repository.repositoryRoot, change.path);
          const buffer = await readFile(absolute).catch(() => Buffer.alloc(0));
          newSide = buffer.includes(0) ? { binary: true, text: undefined } : { binary: false, text: buffer.toString("utf8") };
        }
      }
      const binary = oldSide.binary || newSide.binary;
      const max = 5 * 1024 * 1024;
      const tooLarge = (oldSide.text?.length ?? 0) + (newSide.text?.length ?? 0) > max;
      truncated ||= tooLarge;
      files.push({ path: change.path, oldPath: change.oldPath, status: change.status, binary, oldText: binary || tooLarge ? undefined : oldSide.text, newText: binary || tooLarge ? undefined : newSide.text, truncated: tooLarge });
    }
    const revision = this.revisions.get(repository.id) ?? 0;
    return { id: createHash("sha1").update(`${repository.id}:${scope}:${hash ?? ""}:${selectedPath ?? ""}:${revision}`).digest("hex"), scope, base, target, generatedAt: new Date().toISOString(), gitRevision: revision, truncated, files };
  }
}
