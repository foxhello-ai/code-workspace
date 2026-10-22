import type { GitFetchResult } from "../../shared/contracts.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";

// Shared by browser sessions, keyed by canonical common-dir identity, never by remote URL.
export class RepositoryTasks {
  private fetching = new Map<string, Promise<GitFetchResult>>();
  private locks = new Map<string, Promise<unknown>>();
  readonly sync = new Map<string, GitFetchResult>();
  onChange?: (groupId: string) => void;

  async exclusive<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(groupId) ?? Promise.resolve();
    const task = prior.catch(() => undefined).then(operation);
    this.locks.set(groupId, task);
    try { return await task; } finally { if (this.locks.get(groupId) === task) this.locks.delete(groupId); }
  }

  fetch(groupId: string, runner: GitRunner): Promise<GitFetchResult> {
    const pending = this.fetching.get(groupId);
    if (pending) return pending;
    const task = this.exclusive(groupId, async () => {
      const startedAt = new Date().toISOString();
      const names = (await runner.text(["remote"])).trim().split("\n").filter(Boolean);
      const previous = this.sync.get(groupId);
      const remotes: GitFetchResult["remotes"] = [];
      for (const name of names) {
        const prior = previous?.remotes.find(r => r.name === name);
        try {
          if (name.startsWith("-") || /[\s\0]/.test(name)) throw new Error("invalid remote");
          // Override narrow refspecs for this invocation only. Tags are separate so pruning
          // remote heads can never delete a local tag. No forced tag replacement either.
          const settings = ["-c", "credential.interactive=false", "-c", "core.askPass=", "-c", "fetch.pruneTags=false", "-c", `remote.${name}.pruneTags=false`];
          await runner.run([...settings, "fetch", "--prune", "--no-prune-tags", "--no-tags", "--", name, `+refs/heads/*:refs/remotes/${name}/*`], { write: true, network: true, timeoutMs: config.gitFetchTimeoutMs });
          await runner.run([...settings, "fetch", "--no-prune", "--no-prune-tags", "--no-tags", "--", name, "refs/tags/*:refs/tags/*"], { write: true, network: true, timeoutMs: config.gitFetchTimeoutMs });
          const finishedAt = new Date().toISOString();
          remotes.push({ name, success: true, finishedAt, lastSuccessAt: finishedAt });
        } catch (error) {
          // Network stderr may include credential-bearing URLs or helper output. Never expose it.
          const timeout = error instanceof AppError && error.code === "GIT_TIMEOUT";
          remotes.push({ name, success: false, finishedAt: new Date().toISOString(), lastSuccessAt: prior?.lastSuccessAt, error: timeout ? "同步超时；请检查网络后重试" : "同步失败；请检查远程连接、认证权限或 Tag 冲突后重试" });
        }
      }
      const result = { repositoryGroupId: groupId, startedAt, finishedAt: new Date().toISOString(), remotes };
      this.sync.set(groupId, result);
      this.onChange?.(groupId);
      return result;
    });
    this.fetching.set(groupId, task);
    void task.finally(() => { if (this.fetching.get(groupId) === task) this.fetching.delete(groupId); }).catch(() => undefined);
    return task;
  }
}
