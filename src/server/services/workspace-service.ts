import path from "node:path";
import { createHash } from "node:crypto";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import type { GitRepositoryInfo, WorkspaceInfo } from "../../shared/contracts.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { gitIdentity, readRegistry } from "./git-registry.js";
import { PathGuard } from "../security/path-guard.js";

export interface WorkspaceContext { info: WorkspaceInfo; guard: PathGuard; gitRunners: Map<string, GitRunner> }

const ignoredDiscoveryDirs = new Set([".git", "node_modules", "target", "dist", "build", "coverage", ".gradle", ".idea", ".cursor"]);

export class WorkspaceService {
  private registryQueue: Promise<unknown> = Promise.resolve();
  private current: WorkspaceContext | null = null;
  onChange?: (context: WorkspaceContext | null) => Promise<void> | void;

  get() { if (!this.current) throw new AppError(404, "WORKSPACE_NOT_OPEN", "尚未打开工作区"); return this.current; }

  async open(inputPath: string) {
    const root = await realpath(inputPath).catch(() => { throw new AppError(404, "PATH_NOT_FOUND", "工作区目录不存在"); });
    const info = await stat(root);
    if (!info.isDirectory()) throw new AppError(400, "INVALID_WORKSPACE", "工作区必须是目录");
    await access(root);
    const guard = await PathGuard.create(root);
    const discovery = await this.discoverGitRepositories(root);
    const repositories = discovery.repositories.map((repository, index) => ({ ...repository, current: index === 0 }));
    const git = repositories[0] ?? null;
    this.current = {
      info: { id: createHash("sha256").update(root).digest("hex").slice(0, 16), name: path.basename(root), rootPath: root, openedAt: new Date().toISOString(), git, repositories, repositoryDiscovery: discovery.summary },
      guard,
      gitRunners: new Map(repositories.map((repository) => [repository.id, new GitRunner(repository.repositoryRoot)]))
    };
    await this.refreshGroups();
    await this.onChange?.(this.current);
    return this.current.info;
  }

  async close() { this.current = null; await this.onChange?.(null); }

  getRepository(repositoryId?: string) {
    const context = this.get();
    const repository = repositoryId ? context.info.repositories.find((item) => item.id === repositoryId) : context.info.git;
    if (!repository) throw new AppError(503, "GIT_UNAVAILABLE", "当前工作区未选择 Git 项目");
    const runner = context.gitRunners.get(repository.id);
    if (!runner) throw new AppError(503, "GIT_UNAVAILABLE", "Git 项目不可用");
    return { context, repository, runner };
  }

  refreshGroups() {
    const task = this.registryQueue.catch(() => undefined).then(() => this.readGroups());
    this.registryQueue = task;
    return task;
  }

  private async readGroups() {
    const context = this.get();
    const representatives: GitRepositoryInfo[] = [];
    for (const groupId of new Set(context.info.repositories.map(r => r.repositoryGroupId))) {
      const candidates = context.info.repositories.filter(r => r.repositoryGroupId === groupId);
      let representative = candidates[0];
      for (const candidate of candidates) if (await stat(candidate.repositoryRoot).then(s => s.isDirectory()).catch(() => false)) { representative = candidate; break; }
      representatives.push(representative);
    }
    const groups = await Promise.all(representatives.map(r => readRegistry(r, context.info.rootPath, context.info.repositories)));
    context.info = { ...context.info, repositoryGroups: groups };
    for (const group of groups) for (const worktree of group.worktrees) {
      if (!worktree.inWorkspace || worktree.missing || worktree.bare || worktree.repositoryId) continue;
      const repository = await this.probeRepository(context.info.rootPath, worktree.path, worktree.workspacePath ?? "", 0);
      if (repository && repository.repositoryGroupId === group.repositoryGroupId) {
        context.info.repositories.push(repository);
        context.gitRunners.set(repository.id, new GitRunner(repository.repositoryRoot));
        worktree.repositoryId = repository.id;
      }
    }
    const registered = new Set(groups.flatMap(g => g.worktrees.map(w => w.worktreeId)));
    context.info.repositories = context.info.repositories.filter(r => registered.has(r.worktreeId) || context.info.repositoryGroups?.find(g => g.repositoryGroupId === r.repositoryGroupId)?.error || context.info.repositoryGroups?.find(g => g.repositoryGroupId === r.repositoryGroupId)?.truncated);
    context.info.git = context.info.repositories.find(r => r.id === context.info.git?.id) ?? context.info.repositories[0] ?? null;
    return groups;
  }

  getGroup(groupId?: string) {
    const context = this.get();
    const id = groupId ?? context.info.git?.repositoryGroupId;
    const group = context.info.repositoryGroups?.find(g => g.repositoryGroupId === id);
    if (!group) throw new AppError(404, "GIT_GROUP_NOT_FOUND", "当前工作区中未发现该共享仓库");
    const repository = context.info.repositories.find(r => r.repositoryGroupId === group.repositoryGroupId);
    if (!repository) throw new AppError(404, "GIT_GROUP_NOT_FOUND", "共享仓库无可用工作目录");
    return { group, ...this.getRepository(repository.id) };
  }

  repositories() { return this.get().info.repositories; }

  async selectRepository(repositoryId: string) {
    const context = this.get();
    const found = context.info.repositories.find((repository) => repository.id === repositoryId);
    if (!found) throw new AppError(404, "GIT_REPOSITORY_NOT_FOUND", "Git 项目不存在或已发生变化");
    context.info = {
      ...context.info,
      git: { ...found, current: true },
      repositories: context.info.repositories.map((repository) => ({ ...repository, current: repository.id === repositoryId }))
    };
    return context.info;
  }

  async refreshGitInfo() {
    const context = this.get();
    const repositories = await Promise.all(context.info.repositories.map(async (repository) => {
      const runner = context.gitRunners.get(repository.id);
      if (!runner) return repository;
      return this.refreshRepository(repository, runner).catch(() => repository);
    }));
    const currentId = context.info.git?.id;
    context.info = {
      ...context.info,
      repositories: context.info.repositories.map((repository) => ({ ...(repositories.find(r => r.id === repository.id) ?? repository), current: repository.id === currentId })),
      git: repositories.find((repository) => repository.id === currentId) ?? context.info.repositories[0] ?? null
    };
    await this.refreshGroups();
    return context.info;
  }

  private async discoverGitRepositories(root: string) {
    const depth = Math.max(0, config.gitDiscoveryDepth);
    const maxDirs = Math.max(1, config.gitDiscoveryMaxDirs);
    const deadline = Date.now() + Math.max(1, config.gitDiscoveryTimeoutMs);
    const queue: Array<{ absolute: string; workspacePath: string; depth: number }> = [{ absolute: root, workspacePath: "", depth: 0 }];
    const seenRepos = new Set<string>();
    const repositories: GitRepositoryInfo[] = [];
    let checkedDirs = 0;
    let timedOut = false;
    let truncated = false;

    while (queue.length) {
      if (Date.now() > deadline) { timedOut = true; break; }
      if (checkedDirs >= maxDirs) { truncated = true; break; }
      const candidate = queue.shift()!;
      checkedDirs++;
      const repository = await this.probeRepository(root, candidate.absolute, candidate.workspacePath, candidate.depth);
      if (repository) {
        if (!seenRepos.has(repository.repositoryRoot)) {
          seenRepos.add(repository.repositoryRoot); repositories.push(repository);
        } else {
          const existing = repositories.find(r => r.repositoryRoot === repository.repositoryRoot)!;
          existing.workspacePaths = [...new Set([...(existing.workspacePaths ?? [existing.workspacePath]), candidate.workspacePath])];
        }
        continue;
      }
      if (candidate.depth >= depth) continue;
      const entries = await readdir(candidate.absolute, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (ignoredDiscoveryDirs.has(entry.name)) continue;
        const childLogicalPath = candidate.workspacePath ? `${candidate.workspacePath}/${entry.name}` : entry.name;
        const childAbsolute = path.join(candidate.absolute, entry.name);
        const linkStat = await lstat(childAbsolute).catch(() => null);
        if (!linkStat || (!linkStat.isDirectory() && !linkStat.isSymbolicLink())) continue;
        const childReal = await realpath(childAbsolute).catch(() => null);
        if (!childReal) continue;
        if (!(await stat(childReal).then((item) => item.isDirectory()).catch(() => false))) continue;
        queue.push({ absolute: childReal, workspacePath: childLogicalPath.replaceAll("\\", "/"), depth: candidate.depth + 1 });
      }
    }

    repositories.sort((a, b) => a.discoveryDepth - b.discoveryDepth || a.workspacePath.localeCompare(b.workspacePath, undefined, { numeric: true, sensitivity: "base" }));
    return { repositories, summary: { depth, maxDirs, timedOut, truncated, checkedDirs } };
  }

  private async probeRepository(root: string, absolute: string, workspacePath: string, discoveryDepth: number): Promise<GitRepositoryInfo | null> {
    const probe = new GitRunner(absolute);
    const repoRoot = (await probe.text(["rev-parse", "--show-toplevel"], { allowFailure: true, timeoutMs: 2000 })).trim();
    if (!repoRoot) return null;
    const repoRootReal = await realpath(repoRoot).catch(() => repoRoot);
    if (repoRootReal !== absolute) return null;
    const runner = new GitRunner(repoRootReal);
    const branch = (await runner.text(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true })).trim() || null;
    const head = (await runner.text(["rev-parse", "--verify", "HEAD"], { allowFailure: true })).trim() || null;
    const logicalPath = workspacePath || "";
    const name = logicalPath ? path.basename(logicalPath) : path.basename(root);
    return { ...await gitIdentity(repoRootReal), id: createHash("sha256").update(repoRootReal).digest("hex").slice(0, 16), name, workspacePath: logicalPath, repositoryRoot: repoRootReal, branch, head, detached: !branch && Boolean(head), current: false, discoveryDepth };
  }

  private async refreshRepository(repository: GitRepositoryInfo, runner: GitRunner) {
    const branch = (await runner.text(["symbolic-ref", "--short", "-q", "HEAD"], { allowFailure: true })).trim() || null;
    const head = (await runner.text(["rev-parse", "--verify", "HEAD"], { allowFailure: true })).trim() || null;
    return { ...repository, branch, head, detached: !branch && Boolean(head) };
  }
}
