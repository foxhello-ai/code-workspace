import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileContent, FileTreeEntry, GitState } from "../../shared/contracts.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { inside } from "./git-registry.js";
import { WorkspaceService } from "./workspace-service.js";

const languageMap: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", py: "python", sh: "shell", yml: "yaml", yaml: "yaml", sql: "sql", rs: "rust", go: "go" };

export class FileService {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private workspace: WorkspaceService, private gitState: (path: string) => GitState = () => null) {}

  async tree(relative = "", showHidden = true) {
    const { absolute } = await this.workspace.get().guard.resolveExisting(relative);
    const dirStat = await stat(absolute);
    if (!dirStat.isDirectory()) throw new AppError(400, "NOT_A_DIRECTORY", "目标不是目录");
    const entries = await readdir(absolute, { withFileTypes: true });
    const result: FileTreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || (!showHidden && entry.name.startsWith("."))) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(absolute, entry.name);
      const s = await lstat(full).catch(() => null);
      const target = entry.isSymbolicLink() ? await stat(full).catch(() => null) : null;
      const kind = target?.isDirectory() || entry.isDirectory() ? "directory" : "file";
      result.push({
        name: entry.name, path: rel.replaceAll("\\", "/"),
        kind,
        size: s?.size, modifiedAt: s?.mtime.toISOString(), hidden: entry.name.startsWith("."),
        expandable: kind === "directory", gitState: this.gitState(rel.replaceAll("\\", "/"))
      });
    }
    return result.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "directory" ? -1 : 1);
  }

  private classify(buffer: Buffer) {
    const sample = buffer.subarray(0, 8192);
    const binary = sample.includes(0);
    if (binary) return { binary: true, encoding: "unknown" as const };
    const decoded = new TextDecoder("utf-8", { fatal: true });
    try { decoded.decode(buffer); return { binary: false, encoding: "utf-8" as const }; }
    catch { return { binary: false, encoding: "unknown" as const }; }
  }

  private version(buffer: Buffer, size: number, mtimeMs: number) { return `v1:${size}:${Math.trunc(mtimeMs * 1e6)}:${createHash("sha256").update(buffer).digest("hex")}`; }

  async read(relative: string): Promise<FileContent> {
    const { absolute } = await this.workspace.get().guard.resolveExisting(relative);
    const s = await stat(absolute);
    if (!s.isFile()) throw new AppError(400, "NOT_A_FILE", "目标不是文件");
    if (s.size > config.fileReadonlyBytes) return { path: relative, content: null, encoding: "unknown", lineEnding: "none", version: `meta:${s.size}:${s.mtimeMs}`, size: s.size, readOnly: true, binary: false, finalNewline: false };
    const buffer = await readFile(absolute);
    const classification = this.classify(buffer);
    const version = this.version(buffer, s.size, s.mtimeMs);
    if (classification.binary || classification.encoding === "unknown") return { path: relative, content: null, ...classification, lineEnding: "none", version, size: s.size, readOnly: true, finalNewline: false };
    const content = buffer.toString("utf8");
    const hasCrLf = content.includes("\r\n");
    const withoutCrLf = content.replaceAll("\r\n", "");
    const hasLf = withoutCrLf.includes("\n");
    const lineEnding = hasCrLf && hasLf ? "mixed" : hasCrLf ? "CRLF" : hasLf ? "LF" : "none";
    const ext = path.extname(relative).slice(1).toLowerCase();
    return { path: relative, content, encoding: "utf-8", lineEnding, version, size: s.size, readOnly: false, binary: false, language: languageMap[ext] ?? "plaintext", finalNewline: content.endsWith("\n") };
  }

  async save(relative: string, content: string, expectedVersion: string) {
    const prior = this.locks.get(relative) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.locks.set(relative, queued);
    await prior;
    try {
      const { absolute } = await this.workspace.get().guard.resolveExisting(relative);
      const current = await this.read(relative);
      if (current.version !== expectedVersion) throw new AppError(409, "FILE_VERSION_CONFLICT", "文件已在磁盘上发生变化", { currentVersion: current.version });
      const s = await stat(absolute);
      const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
      await writeFile(temp, content, { encoding: "utf8", mode: s.mode });
      await rename(temp, absolute);
      await chmod(absolute, s.mode);
      return this.read(relative);
    } finally { release(); if (this.locks.get(relative) === queued) this.locks.delete(relative); }
  }

  async createFile(relative: string, content = "") {
    const { absolute } = await this.workspace.get().guard.resolveNew(relative);
    if (await stat(absolute).then(() => true).catch(() => false)) throw new AppError(409, "PATH_EXISTS", "目标已经存在");
    await writeFile(absolute, content, { flag: "wx" });
    return this.read(relative);
  }

  async createDirectory(relative: string) {
    const { absolute } = await this.workspace.get().guard.resolveNew(relative);
    await mkdir(absolute);
  }

  private async protectWorktree(relative: string) {
    const context = this.workspace.get();
    const logical = context.guard.resolveLogical(relative);
    // A plain symlink alias can be unlinked/renamed without touching its target.
    if ((await lstat(logical.absolute)).isSymbolicLink()) return;
    const actual = await realpath(logical.absolute);
    const groups = await this.workspace.refreshGroups();
    const roots = [...context.info.repositories.map(r => r.repositoryRoot), ...groups.flatMap(g => g.worktrees.map(w => w.path))];
    if (roots.some(root => inside(actual, root))) throw new AppError(409, "WORKTREE_ROOT_PROTECTED", "此目录包含 Git worktree 根目录，请使用 worktree 清理预览和专用移除流程");
  }

  async move(from: string, to: string) {
    await this.workspace.get().guard.resolveExisting(from);
    await this.protectWorktree(from);
    const source = this.workspace.get().guard.resolveLogical(from);
    const target = await this.workspace.get().guard.resolveNew(to);
    if (await stat(target.absolute).then(() => true).catch(() => false)) throw new AppError(409, "PATH_EXISTS", "目标已经存在");
    await rename(source.absolute, target.absolute);
  }

  async remove(relative: string, recursive: boolean, confirmed: boolean) {
    if (!confirmed) throw new AppError(400, "CONFIRMATION_REQUIRED", "删除操作需要确认");
    await this.workspace.get().guard.resolveExisting(relative);
    await this.protectWorktree(relative);
    const target = this.workspace.get().guard.resolveLogical(relative);
    await rm(target.absolute, { recursive, force: false });
  }
}
