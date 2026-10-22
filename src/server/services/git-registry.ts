import path from "node:path";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { GitRepositoryGroup, GitRepositoryInfo, GitWorktree } from "../../shared/contracts.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { config } from "../config.js";

export const stableId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export const inside = (root: string, target: string) => { const rel = path.relative(root, target); return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
export async function gitIdentity(root: string) {
  const runner = new GitRunner(root);
  const common = (await runner.text(["rev-parse", "--git-common-dir"])).trim();
  const commonDir = await realpath(path.resolve(root, common));
  return { commonDir, repositoryGroupId: stableId(commonDir), worktreeId: stableId(await realpath(root)) };
}

// Porcelain -z is required: quoted human output cannot represent arbitrary worktree paths reliably.
export async function readRegistry(repository: GitRepositoryInfo, workspaceRoot: string, repositories: GitRepositoryInfo[]): Promise<GitRepositoryGroup> {
  const group: GitRepositoryGroup = { repositoryGroupId: repository.repositoryGroupId, commonDir: repository.commonDir, name: path.basename(path.dirname(repository.commonDir)), worktrees: [], truncated: false };
  try {
    const deadline = Date.now() + config.gitTimeoutMs;
    const raw = await new GitRunner(repository.repositoryRoot).text(["worktree", "list", "--porcelain", "-z"]);
    const records: Array<Record<string, string>> = [];
    let record: Record<string, string> = {};
    for (const field of raw.split("\0")) {
      if (!field) { if (record.worktree) records.push(record); record = {}; continue; }
      const index = field.indexOf(" "); record[index < 0 ? field : field.slice(0, index)] = index < 0 ? "" : field.slice(index + 1);
    }
    if (record.worktree) records.push(record);
    group.truncated = records.length > config.gitWorktreeLimit;
    const bounded = records.slice(0, config.gitWorktreeLimit);
    // Bound subprocess concurrency even for large registries.
    for (let offset = 0; offset < bounded.length; offset += 4) {
      group.worktrees.push(...await Promise.all(bounded.slice(offset, offset + 4).map(async (item): Promise<GitWorktree> => {
        const canonical = await realpath(item.worktree).catch(() => path.resolve(item.worktree));
        const exists = await stat(canonical).then(s => s.isDirectory()).catch(() => false);
        const matched = repositories.find(r => r.repositoryRoot === canonical);
        const bare = "bare" in item;
        let gitDir: string | undefined;
        if (exists && !bare) {
          try { gitDir = await realpath((await new GitRunner(canonical, deadline).text(["rev-parse", "--absolute-git-dir"])).trim()); } catch { /* unknown identity */ }
        }
        return { worktreeId: stableId(canonical), repositoryGroupId: repository.repositoryGroupId, repositoryId: matched?.id,
          path: canonical, workspacePath: matched?.workspacePath ?? (inside(workspaceRoot, canonical) ? path.relative(workspaceRoot, canonical).replaceAll("\\", "/") : undefined),
          head: item.HEAD && !/^0+$/.test(item.HEAD) ? item.HEAD : null, branch: item.branch?.replace(/^refs\/heads\//, "") ?? null,
          main: bare ? null : gitDir ? gitDir === repository.commonDir : null, current: Boolean(matched?.current), inWorkspace: inside(workspaceRoot, canonical),
          missing: !exists, bare, locked: "locked" in item ? item.locked || "已锁定" : undefined, prunable: "prunable" in item ? item.prunable || "登记已失效" : undefined, gitDir };
      })));
    }
  } catch { group.error = "无法读取 worktree 登记；需要 Git 2.39+（支持 porcelain -z），请检查 Git 及目录权限"; }
  return group;
}
