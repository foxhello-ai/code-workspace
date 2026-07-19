import path from "node:path";
import { createHash } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import type { WorkspaceInfo } from "../../shared/contracts.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { PathGuard } from "../security/path-guard.js";

export interface WorkspaceContext { info: WorkspaceInfo; guard: PathGuard; gitRunner: GitRunner | null }

export class WorkspaceService {
  private current: WorkspaceContext | null = null;
  onChange?: (context: WorkspaceContext | null) => Promise<void> | void;

  get() { if (!this.current) throw new AppError(404, "WORKSPACE_NOT_OPEN", "尚未打开工作区"); return this.current; }

  async open(inputPath: string) {
    const root = await realpath(inputPath).catch(() => { throw new AppError(404, "PATH_NOT_FOUND", "工作区目录不存在"); });
    const info = await stat(root);
    if (!info.isDirectory()) throw new AppError(400, "INVALID_WORKSPACE", "工作区必须是目录");
    await access(root);
    const probe = new GitRunner(root);
    const repoRootText = await probe.text(["rev-parse", "--show-toplevel"], { allowFailure: true });
    const repoRoot = repoRootText.trim();
    let git: WorkspaceInfo["git"] = null;
    let runner: GitRunner | null = null;
    if (repoRoot) {
      runner = new GitRunner(repoRoot);
      const branch = (await runner.text(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true })).trim() || null;
      const head = (await runner.text(["rev-parse", "--verify", "HEAD"], { allowFailure: true })).trim() || null;
      git = { repositoryRoot: repoRoot, branch, head, detached: !branch && Boolean(head) };
    }
    const guard = await PathGuard.create(root);
    this.current = {
      info: { id: createHash("sha256").update(root).digest("hex").slice(0, 16), name: path.basename(root), rootPath: root, openedAt: new Date().toISOString(), git },
      guard,
      gitRunner: runner
    };
    await this.onChange?.(this.current);
    return this.current.info;
  }

  async close() { this.current = null; await this.onChange?.(null); }

  async refreshGitInfo() {
    const context = this.get();
    if (!context.gitRunner || !context.info.git) return context.info;
    const branch = (await context.gitRunner.text(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true })).trim() || null;
    const head = (await context.gitRunner.text(["rev-parse", "--verify", "HEAD"], { allowFailure: true })).trim() || null;
    context.info = { ...context.info, git: { ...context.info.git, branch, head, detached: !branch && Boolean(head) } };
    return context.info;
  }
}
