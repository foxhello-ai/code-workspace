import { createHash } from "node:crypto";
import type { GitWorktree, RemovalPreview, WorktreeOverview, WorktreeStatus } from "../../shared/contracts.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { GitRunner } from "../infrastructure/git-runner.js";
import { GitService } from "./git-service.js";
import { RepositoryTasks } from "./repository-tasks.js";
import { WorkspaceService } from "./workspace-service.js";
import { readGitRemoteAddresses } from "./git-remotes.js";

export interface EditorOccupancy { unsavedCount: number; otherSessionCount: number }
export class WorktreeService {
  constructor(private workspace: WorkspaceService, private git: GitService, private tasks: RepositoryTasks, private occupancy: (worktree: GitWorktree) => EditorOccupancy) {}

  async overview(groupId?: string): Promise<WorktreeOverview> {
    const groups = await this.workspace.refreshGroups();
    if (groupId) this.workspace.getGroup(groupId);
    const result: WorktreeOverview = { groups: [] };
    let remaining = config.gitStatusLimit;
    for (const group of groups.filter(g => !groupId || g.repositoryGroupId === groupId)) {
      const repository = this.workspace.get().info.repositories.find(r => r.repositoryGroupId === group.repositoryGroupId)!;
      const remote = readGitRemoteAddresses(repository.repositoryRoot);
      const worktrees: WorktreeStatus[] = [];
      for (let offset = 0; offset < group.worktrees.length; offset += 4) {
        worktrees.push(...await Promise.all(group.worktrees.slice(offset, offset + 4).map(w => this.read(w, remaining-- > 0))));
      }
      result.groups.push({ ...group, worktrees, changedFileCount: worktrees.reduce((n, w) => n + (w.status?.files.length ?? 0), 0), unknownCount: worktrees.filter(w => !w.status).length, sync: this.tasks.sync.get(group.repositoryGroupId), remote: await remote });
    }
    return result;
  }

  async read(worktree: GitWorktree, enabled = true): Promise<WorktreeStatus> {
    const result: WorktreeStatus = { ...worktree, current: this.workspace.get().info.git?.worktreeId === worktree.worktreeId, readAt: new Date().toISOString(), status: null, upstream: null, unpublished: null, defaultBranch: null, defaultRelation: "unknown", syncNote: "尚未在本服务同步；以下指标仅依据本地远程引用" };
    if (!enabled || worktree.missing || worktree.bare) { result.error = !enabled ? "状态数量超限，尚未读取" : worktree.missing ? "目录缺失" : "裸仓库无工作目录"; return result; }
    const runner = new GitRunner(worktree.path, Date.now() + config.gitTimeoutMs);
    try {
      result.status = await this.git.statusAt({ id: worktree.worktreeId }, runner);
      result.head = result.status.head; result.branch = result.status.branch;
      const sync = this.tasks.sync.get(worktree.repositoryGroupId);
      if (sync?.remotes.length) result.syncNote = sync.remotes.every(r => r.success) ? `同步于 ${sync.finishedAt}；远程指标为本地快照` : "最近同步有失败；指标仅依据已有本地远程引用";
      if (!result.head) return result;
      const upstream = (await runner.text(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true })).trim();
      if (upstream) {
        const [ahead, behind] = (await runner.text(["rev-list", "--left-right", "--count", `HEAD...${upstream}`, "--"])).trim().split(/\s+/).map(Number);
        result.upstream = { ref: upstream, ahead, behind };
      }
      const remoteRefs = (await runner.text(["for-each-ref", "--format=%(refname)", "refs/remotes"])).trim().split("\n").filter(Boolean);
      if (remoteRefs.length) result.unpublished = Number((await runner.text(["rev-list", "--count", "HEAD", "--not", ...remoteRefs, "--"])).trim());
      const defaults = (await runner.text(["for-each-ref", "--format=%(symref)", "refs/remotes"])).trim().split("\n").filter(Boolean);
      const candidates = [...new Set(defaults)];
      if (candidates.length === 1) {
        const defaultRef = candidates[0];
        result.defaultBranch = defaultRef.replace(/^refs\/remotes\//, "");
        const target = (await runner.text(["rev-parse", "--verify", defaultRef])).trim();
        const base = (await runner.text(["merge-base", "HEAD", defaultRef], { allowFailure: true })).trim();
        result.defaultRelation = target === result.head ? "equal" : base === result.head ? "ancestor" : base === target ? "descendant" : base ? "diverged" : "unknown";
      }
    } catch { result.status = null; result.upstream = null; result.unpublished = null; result.defaultRelation = "unknown"; result.error = "Git 状态查询失败或超时，请手动刷新"; }
    return result;
  }

  async preview(worktreeId: string): Promise<RemovalPreview> {
    const groups = await this.workspace.refreshGroups();
    const registered = groups.flatMap(g => g.worktrees).find(w => w.worktreeId === worktreeId);
    if (!registered) throw new AppError(404, "WORKTREE_NOT_FOUND", "worktree 不在当前工作区的登记清单中");
    const worktree = await this.read(registered);
    const group = groups.find(g => g.repositoryGroupId === worktree.repositoryGroupId)!;
    const reasons: string[] = [], warnings: string[] = ["仅识别本服务的活跃会话；执行前仍需确认外部程序未使用该目录"];
    const occupied = this.occupancy(worktree);
    if (worktree.main !== false) reasons.push(worktree.main ? "Git 主 worktree 禁止移除" : "无法确认主/关联身份");
    if (worktree.current) reasons.push("当前选中的 worktree，请先切换");
    if (!worktree.inWorkspace) reasons.push("工作区外登记项只读");
    if (worktree.missing) reasons.push("目录缺失");
    if (worktree.bare) reasons.push("裸仓库不可移除");
    if (worktree.locked !== undefined) reasons.push(`已锁定：${worktree.locked}`);
    if (worktree.prunable !== undefined) reasons.push(`登记失效：${worktree.prunable}`);
    if (group.error || group.truncated) reasons.push("登记清单不完整");
    if (!worktree.status) reasons.push("文件状态未知");
    else if (!worktree.status.clean) reasons.push(`存在 ${worktree.status.files.length} 个未提交/未跟踪/冲突文件`);
    if (occupied.unsavedCount) reasons.push(`存在 ${occupied.unsavedCount} 个未保存编辑`);
    if (occupied.otherSessionCount) reasons.push(`被其他 ${occupied.otherSessionCount} 个活跃会话使用`);
    let ignoredCount: number | null = null;
    let ignoredFiles = "", preservedRefs = "";
    if (!worktree.missing && !worktree.bare) {
      const runner = new GitRunner(worktree.path, Date.now() + config.gitTimeoutMs);
      try {
        ignoredFiles = await runner.text(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--directory"]);
        ignoredCount = ignoredFiles.split("\0").filter(Boolean).length;
        if (ignoredCount) reasons.push(`包含 ${ignoredCount} 个忽略文件/目录，需先处理`);
        if (worktree.head) {
          preservedRefs = await runner.text(["for-each-ref", `--contains=${worktree.head}`, "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes", "refs/tags"]);
          if (!worktree.branch && !preservedRefs.trim()) reasons.push("detached HEAD 的提交尚未被分支或 Tag 保留");
        }
      } catch { reasons.push("无法检查忽略文件或提交保留情况"); }
    }
    if (worktree.unpublished) warnings.push(`${worktree.unpublished} 个提交尚未被本地远程引用包含；移除后保留本地分支及其提交`);
    if (worktree.unpublished === null) warnings.push("未发布提交数未知；请检查远程同步情况");
    const branchPreserved = worktree.branch;
    // Exclude read timestamps/revision counters: token changes only with material state.
    const token = createHash("sha256").update(JSON.stringify({ registered, files: worktree.status?.files, head: worktree.head, ignoredFiles, preservedRefs, occupied, reasons, unpublished: worktree.unpublished })).digest("hex");
    return { worktree, token, allowed: reasons.length === 0, reasons, warnings, ignoredCount, ...occupied, branchPreserved };
  }
}
