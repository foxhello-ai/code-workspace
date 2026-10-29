import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, CornerUpLeft, FileCheck2, FolderGit2, GitBranch, Layers } from "lucide-react";
import type { ChangeCategory, GitRepositoryInfo, GitWorktree } from "../shared/contracts";
import { api } from "./api";
import { GitDiff, type DiffSelection } from "./GitDiff";
import { groupByGitAddress, HistoryPanel, SyncControl } from "./GitPanels";

export function RepositorySidebar({ scope, onScope, current, active = true }: { scope: string; onScope(scope: string, groupId?: string): void; current: GitRepositoryInfo | null; active?: boolean }) {
  const query = useQuery({ queryKey: ["git", "worktrees"], queryFn: api.worktrees, enabled: active, retry: false });
  const collections = groupByGitAddress(query.data?.groups ?? []);
  const count = query.data?.groups.reduce((sum, group) => sum + group.worktrees.length, 0);
  return <nav className="repository-sidebar" aria-label="仓库与本地仓库">
    <div className="repository-nav-title">仓库<span>{collections.length}</span></div>
    <button className="repository-nav-all" aria-pressed={scope === "all"} onClick={() => onScope("all")}><Layers size={15}/><span>全部仓库</span><small>{count ?? "—"}</small></button>
    {query.isError && <p className="error">仓库列表读取失败，请刷新状态重试。</p>}
    {collections.map(collection => <section className="repository-nav-group" key={collection.key}>
      <button aria-pressed={scope === collection.key} title={collection.url ?? collection.bases[0].commonDir} onClick={() => onScope(collection.key, collection.bases[0].repositoryGroupId)}><FolderGit2 size={16}/><span><strong>{collection.name}</strong><small>{collection.bases.length} 个本地仓库</small></span><em>{collection.bases.reduce((sum, group) => sum + group.worktrees.length, 0)}</em></button>
      {collection.bases.map(group => <button key={group.repositoryGroupId} className="repository-nav-base" aria-pressed={scope === `base:${group.repositoryGroupId}`} title={`本地仓库：${group.commonDir}`} onClick={() => onScope(`base:${group.repositoryGroupId}`, group.repositoryGroupId)}><span>{group.name}</span><small>{group.worktrees.length}</small></button>)}
    </section>)}
    {current && <div className="repository-nav-context"><small>当前 Git 上下文</small><strong title={current.repositoryRoot}>{current.name}</strong><span title={current.branch ?? "detached HEAD"}><GitBranch size={13}/>{current.branch ?? "detached HEAD"}</span></div>}
  </nav>;
}

export function GitWorkspace({ repository, tab, onTab, active, branchPicker, focusHash, focusRequest, onWorktree, historyWorktree }: {
  repository: GitRepositoryInfo | null;
  tab: "changes" | "history";
  onTab(tab: "changes" | "history"): void;
  active: boolean;
  branchPicker: ReactNode;
  focusHash?: string;
  focusRequest?: number;
  onWorktree(id: string): void;
  historyWorktree?: GitWorktree;
}) {
  const status = useQuery({ queryKey: ["git", "status", repository?.id], queryFn: () => api.gitStatus(repository!.id), enabled: Boolean(repository) && active && !historyWorktree, retry: false });
  if (!repository) return <div className="workbench-page"><h1>Git</h1><p className="panel-empty">未发现 Git 项目。请在 Worktree 中选择可访问的本地仓库。</p></div>;
  return <div className="workbench-page git-workspace">
    <header className="workbench-page-title"><div><h1>Git</h1><p>{repository.name} <span>／</span> {historyWorktree?.path.split(/[\\/]/).at(-1) ?? (repository.workspacePath || repository.name)}</p></div><SyncControl repositoryGroupId={repository.repositoryGroupId}/></header>
    <div className="git-context-bar">
      {historyWorktree ? <span className="workbench-chip"><GitBranch size={14}/>{historyWorktree.branch ?? "detached HEAD"}</span> : branchPicker}
      <code>{(historyWorktree?.head ?? repository.head)?.slice(0, 8) ?? "无提交"}</code>
      {historyWorktree && <span className="workbench-chip">{historyWorktree.missing ? "目录缺失 · 只读历史" : historyWorktree.inWorkspace ? "只读历史" : "工作区外 · 只读历史"}</span>}
      <button className="workbench-back" onClick={() => onWorktree(historyWorktree?.worktreeId ?? repository.worktreeId)}><CornerUpLeft size={14}/>Worktree 详情</button>
    </div>
    {historyWorktree && <p className="boundary-note">从所属本地仓库读取所选 Worktree 的提交；文件与分支操作限于当前工作区。</p>}
    <div className="git-workspace-tabs" role="tablist" aria-label="Git 视图">
      <button id="git-changes-tab" role="tab" aria-selected={tab === "changes"} aria-controls="git-changes-content" disabled={Boolean(historyWorktree)} onClick={() => onTab("changes")}>工作区修改{status.data && <small>{status.data.files.length}</small>}</button>
      <button id="git-history-tab" role="tab" aria-selected={tab === "history"} aria-controls="git-history-content" onClick={() => onTab("history")}>提交历史</button>
    </div>
    <section id="git-changes-content" role="tabpanel" aria-labelledby="git-changes-tab" hidden={tab !== "changes"}>
      <ChangesWorkbench key={repository.id} repository={repository} active={active && tab === "changes" && !historyWorktree} onHistory={() => onTab("history")}/>
    </section>
    <section id="git-history-content" role="tabpanel" aria-labelledby="git-history-tab" hidden={tab !== "history"}>
      <HistoryPanel key={repository.id} repository={repository} focusHash={focusHash} focusRef={historyWorktree?.branch ? `refs/heads/${historyWorktree.branch}` : undefined} focusRequest={focusRequest} onWorktree={onWorktree} active={active && tab === "history"} embedded/>
    </section>
  </div>;
}

export function ChangesWorkbench({ repository, active = true, onHistory }: { repository: GitRepositoryInfo; active?: boolean; onHistory(): void }) {
  const query = useQuery({ queryKey: ["git", "status", repository.id], queryFn: () => api.gitStatus(repository.id), enabled: active, retry: false });
  const [selection, setSelection] = useState<DiffSelection>();
  const groups: Array<{ category: ChangeCategory; label: string; scope: "working" | "staged" }> = [
    { category: "conflicted", label: "冲突", scope: "working" }, { category: "staged", label: "已暂存", scope: "staged" },
    { category: "unstaged", label: "未暂存", scope: "working" }, { category: "untracked", label: "未跟踪", scope: "working" }
  ];
  const entries = groups.flatMap(group => (query.data?.files.filter(file => file.categories.includes(group.category)) ?? []).map(file => ({ ...group, file })));
  // A file can have both staged and unstaged changes; the scope is part of its selection.
  const selected = selection?.scope === "all" ? selection : entries.find(entry => entry.file.path === selection?.path && entry.scope === selection.scope)
    ? selection : entries[0] ? { scope: entries[0].scope, path: entries[0].file.path } : undefined;
  if (query.isError) return <p className="panel-empty error" role="alert">{query.error instanceof Error ? query.error.message : "修改读取失败"}</p>;
  if (!query.data) return <p className="panel-empty">正在读取文件状态…</p>;
  if (!entries.length) return <div className="git-clean-state"><FileCheck2 size={30}/><h2>工作目录干净</h2><p>没有待查看的文件改动。</p><button onClick={onHistory}>查看提交历史</button></div>;
  return <div className="changes-workbench">
    <aside className="changes-file-list" aria-label="修改文件">
      <button className="changes-all" aria-pressed={selected?.scope === "all"} onClick={() => setSelection({ scope: "all" })}>查看全部修改<small>{query.data.files.length}</small></button>
      {groups.map(group => {
        const files = entries.filter(entry => entry.category === group.category);
        return files.length ? <section key={group.category}><h3><ChevronDown size={13}/>{group.label}<small>{files.length}</small></h3>{files.map(({ file }) => <button key={file.path} aria-pressed={selected?.path === file.path && selected.scope === group.scope} onClick={() => setSelection({ scope: group.scope, path: file.path })} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          <em className={group.category === "conflicted" ? "conflict" : group.category === "untracked" ? "added" : "modified"}>{group.category === "untracked" ? "U" : group.category === "conflicted" ? "!" : group.scope === "staged" ? file.indexStatus : file.worktreeStatus}</em>
          <span><strong>{file.path.split("/").at(-1)}</strong><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "."}</small></span>
        </button>)}</section> : null;
      })}
      <footer>{query.data.files.length} 个文件 · 按暂存状态分别比较</footer>
    </aside>
    {selected && <GitDiff repositoryId={repository.id} selection={selected} active={active}/>}
  </div>;
}
