import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, ChevronRight, CircleDot, CircleHelp, CloudDownload, Copy, FolderGit2, GitBranch, GitCompareArrows, GitGraph, List, LocateFixed, Maximize2, Minimize2, RefreshCw, ScanLine, Search, X } from "lucide-react";
import type { GitCommitDetail, GitGraphCommit, GitHistoryPage, GitRemoteAddresses, GitRepositoryInfo, GitWorktree, HistoryScope, WorktreeOverview, WorktreeStatus } from "../shared/contracts";
import { api, ApiClientError } from "./api";
import { useAppStore } from "./store";
import { GitDiff, type DiffSelection } from "./GitDiff";

const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败";
const graphRowHeight = 72;

export function SyncControl({ repositoryGroupId }: { repositoryGroupId: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const overview = useQuery({ queryKey: ["git", "sync", repositoryGroupId], queryFn: () => api.sync(repositoryGroupId), staleTime: 10000 });
  const sync = overview.data;
  return <div className="sync-control">
    <div className="git-actions"><button title="重新读取本地状态，不连接远程" onClick={() => client.invalidateQueries({ queryKey: ["git"] })}><RefreshCw size={14}/><span>刷新状态</span></button><button disabled={busy} title="获取当前本地共享仓库的远程引用，不合并或修改工作目录" onClick={async () => {
      setBusy(true); setError("");
      try { await api.fetch(repositoryGroupId); await client.invalidateQueries({ queryKey: ["git"] }); }
      catch (error) { setError(errorText(error)); } finally { setBusy(false); }
    }}><CloudDownload size={14}/>{busy ? "正在获取…" : "获取远程"}</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {overview.isError ? <small className="error">远程获取状态读取失败</small> : !sync ? <small>本地快照 · 尚未获取远程</small> : sync.remotes.length === 0 ? <small>未配置远程</small> : sync.remotes.map(r => <small className={r.success ? "" : "error"} key={r.name}>{r.name}：{r.success ? "获取成功" : r.error} · {new Date(r.finishedAt).toLocaleTimeString()}{!r.success && r.lastSuccessAt && <span> · 上次成功 {new Date(r.lastSuccessAt).toLocaleString()}</span>}</small>)}
  </div>;
}

export function HistoryPanel({ repository, onDiff, focusHash, focusRef, focusRequest = 0, onWorktree, active = true, embedded = false }: {
  repository: GitRepositoryInfo | null;
  onDiff?(hash: string, path?: string): void;
  focusHash?: string;
  focusRef?: string;
  focusRequest?: number;
  onWorktree(id: string): void;
  active?: boolean;
  embedded?: boolean;
}) {
  const [mode, setMode] = useState<"list" | "graph">("graph");
  const [scope, setScope] = useState<HistoryScope>("all"), [ref, setRef] = useState("");
  const [selected, setSelected] = useState(focusHash), [pages, setPages] = useState<GitHistoryPage[]>([]);
  const [loading, setLoading] = useState(false), [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false), [locateRequest, setLocateRequest] = useState(0);
  const [diffSelection, setDiffSelection] = useState<DiffSelection>();
  const [focusPending, setFocusPending] = useState(Boolean(focusHash));
  const panel = useRef<HTMLElement>(null), expandButton = useRef<HTMLButtonElement>(null);
  const refs = useQuery({ queryKey: ["git", "refs", repository?.id], queryFn: () => api.refs(repository!.id), enabled: Boolean(repository) && active });
  const first = useQuery({ queryKey: ["git", "graph", repository?.id, scope, ref], queryFn: () => api.graph(0, repository!.id, { scope, ...(scope === "ref" ? { ref } : {}) }), enabled: Boolean(repository) && active && (scope !== "ref" || Boolean(ref)), retry: false });
  useEffect(() => { setPages([]); }, [scope, ref, repository?.id]);
  useEffect(() => {
    setFocusPending(Boolean(focusHash));
    if (focusHash) { setSelected(focusHash); setDiffSelection(undefined); setLocateRequest(n => n + 1); }
  }, [focusHash, focusRef, focusRequest]);
  useEffect(() => { if (!active) setExpanded(false); }, [active]);
  const currentPages = first.data ? [first.data, ...pages.filter(p => p.graphRevision === first.data.graphRevision)] : [];
  const commits = currentPages.flatMap(p => p.items);
  const next = currentPages.at(-1)?.nextCursor;
  useEffect(() => {
    if (!focusPending || !focusHash || !active || !first.data || first.isFetching) return;
    if (!commits.some(commit => commit.hash === focusHash)) {
      if (focusHash === first.data.head) {
        setScope("current"); setNotice("已切到当前 Worktree 分支，定位本地 HEAD");
      } else if (focusRef) {
        if (refs.isPending) return;
        if (refs.data?.some(item => item.fullName === focusRef)) {
          setScope("ref"); setRef(focusRef); setNotice("已切到所选 Worktree 分支，定位提交");
        } else if (scope !== "all") { setScope("all"); return; }
      } else if (scope !== "all") { setScope("all"); return; }
    }
    setFocusPending(false);
  }, [focusPending, focusHash, focusRef, active, first.data, first.isFetching, refs.data, refs.isPending, scope, commits]);
  useEffect(() => { if (!selected && first.data?.items.length) setSelected(first.data.items.find(commit => commit.hash === first.data.head)?.hash ?? first.data.items[0].hash); }, [selected, first.data]);
  const detail = useQuery({ queryKey: ["git", "commit", repository?.id, selected], queryFn: () => api.commit(selected!, repository!.id), enabled: Boolean(repository && selected) && active, retry: false });
  useEffect(() => {
    if (!expanded) return;
    const exit = (event: KeyboardEvent) => { if (event.key === "Escape") { setExpanded(false); expandButton.current?.focus(); } };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [expanded]);
  useEffect(() => {
    if (!selected || !active) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-commit="${selected}"]`)?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [focusHash, mode, expanded, active, first.data, locateRequest]);
  if (!repository) return <p className="panel-empty">未发现 Git 项目</p>;
  const head = first.data?.head;
  const comparison = first.data?.comparison;
  const select = (hash: string) => { setSelected(hash); setDiffSelection(undefined); };
  const diff = (hash: string, path?: string) => {
    if (onDiff) { setExpanded(false); onDiff(hash, path); }
    else setDiffSelection({ scope: "commit", hash, path });
  };
  const openWorktree = (id: string) => { setExpanded(false); onWorktree(id); };
  return <section ref={panel} className={`history-panel history-redesign ${expanded ? "history-fullscreen" : ""}`} aria-label="Git 历史面板">
    {!embedded && <><div className="repo-summary"><strong>{repository.workspacePath || repository.name}</strong><small>{repository.branch ?? "detached"}</small></div><SyncControl repositoryGroupId={repository.repositoryGroupId}/></>}
    <div className="history-local-summary"><div><span className="commit-badge current-head">当前本地 HEAD</span><code>{head?.slice(0, 8) ?? (first.isLoading ? "读取中…" : "无提交")}</code></div><small>{comparison?.upstream ? <>{comparison.upstream.replace(/^refs\/remotes\//, "")} · ↑ {comparison.ahead ?? "?"} 领先 / ↓ {comparison.behind ?? "?"} 落后</> : "未配置 upstream，无法比较跟踪分支"}</small></div>
    <div className="history-toolbar"><div className="history-scope"><label><span className="sr-only">历史范围</span><select aria-label="历史范围" value={scope} onChange={e => { setScope(e.target.value as HistoryScope); setNotice(""); }}><option value="all">全部分支 / Tag / Worktree</option><option value="current">当前 Worktree 分支</option><option value="ref">指定分支或 Tag</option></select></label>{scope === "ref" && <select aria-label="指定引用" value={ref} onChange={e => setRef(e.target.value)}><option value="">选择分支或 Tag</option>{refs.data?.map(r => <option key={r.fullName} value={r.fullName}>{r.kind} · {r.name}</option>)}</select>}</div>
      <button disabled={!head} aria-label="定位" onClick={() => {
        select(head!); setLocateRequest(n => n + 1);
        if (!commits.some(c => c.hash === head)) { setScope("current"); setNotice("已切到当前 Worktree 分支，定位本地 HEAD"); }
      }}><LocateFixed size={14}/>定位 HEAD</button>
      <div className="workbench-segment"><button title="提交图" onClick={() => setMode("graph")} aria-pressed={mode === "graph"}><GitGraph size={14}/>图</button><button title="线性列表" onClick={() => setMode("list")} aria-pressed={mode === "list"}><List size={14}/>列表</button></div>
      <button ref={expandButton} className="history-expand" aria-label={expanded ? "退出全屏" : "全屏查看 Git 历史"} title={expanded ? "退出全屏（Esc）" : "全屏查看"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button>
    </div>
    {first.isError && <p className="error" role="alert">{errorText(first.error)}</p>}
    {refs.isError && scope === "ref" && <p className="error">{errorText(refs.error)}</p>}
    {first.data?.shallow && <p className="boundary-note">浅仓库：历史在浅克隆边界截断</p>}
    {notice && <p className="boundary-note" role="status">{notice}</p>}
    {selected && !commits.some(c => c.hash === selected) && first.data && <p className="boundary-note">所选提交不在已加载范围中，可加载更多或切回全部范围。</p>}
    <div className="history-workbench"><div className="history-picker"><div className="history-column-heading"><span>提交记录</span><small>{commits.length} 条已加载</small></div>
      {first.isLoading && <p className="panel-empty">正在读取提交…</p>}
      {first.data && !commits.length && <p className="panel-empty">当前范围没有提交。</p>}
      {mode === "graph" ? <Graph commits={commits} selected={selected} head={head} onSelect={select} onWorktree={openWorktree}/> : <div className="history-list">{commits.map(commit => <button data-commit={commit.hash} key={commit.hash} className={`${selected === commit.hash ? "selected" : ""} ${head === commit.hash ? "local-head" : ""}`} onClick={() => select(commit.hash)}><strong title={commit.subject}>{commit.subject}</strong><span><code>{commit.shortHash}</code>{commit.authorName}</span><CommitBadges commit={commit} head={head}/></button>)}</div>}
      <div className="history-pagination"><span className="history-progress">已加载 {commits.length} / {first.data?.total ?? "…"} · {Math.max(0, (first.data?.total ?? 0) - commits.length)} 条待加载</span>{next != null && <button disabled={loading} onClick={async () => {
        setLoading(true);
        try {
          const page = await api.graph(next, repository.id, { scope, ...(scope === "ref" ? { ref } : {}), graphRevision: first.data!.graphRevision });
          setPages(p => [...p, page]);
        } catch (error) {
          if (error instanceof ApiClientError && error.code === "GRAPH_CHANGED") { setPages([]); setNotice("引用已变化，已重新加载第一页"); await first.refetch(); }
          else setNotice(errorText(error));
        } finally { setLoading(false); }
      }}>{loading ? "加载中…" : "加载更多提交"}</button>}</div>
    </div><div className="history-detail">{detail.data ? <CommitDetails detail={detail.data} diff={diff}/> : selected ? <p className="panel-empty">{detail.isError ? errorText(detail.error) : "加载提交详情…"}</p> : <p className="panel-empty">选择提交查看详情</p>}</div></div>
    {diffSelection && <section className="history-inline-diff"><header><span>{diffSelection.hash?.slice(0, 8)} · 提交差异</span><button aria-label="关闭提交差异" onClick={() => setDiffSelection(undefined)}><X size={15}/></button></header><GitDiff repositoryId={repository.id} selection={diffSelection} active={active}/></section>}
    <p className="workbench-footnote">浏览分支与 Tag 不切换工作目录 · 本地 / 远程归属以已获取的引用为准</p>
  </section>;
}

function CommitBadges({ commit, head }: { commit: GitGraphCommit; head?: string | null }) {
  const local = commit.inCurrentHistory, remote = commit.inRemoteHistory;
  const kind = local === null || remote === null ? "unknown" : local ? remote ? "shared" : "local-only" : remote ? "remote-only" : "other-history";
  const label = ({ shared: "本地 / 远程共有", "local-only": "本地独有", "remote-only": "远程独有", "other-history": "其他本地引用", unknown: "归属未知" })[kind];
  return <span className="commit-badges">{commit.hash === head && <span className="commit-badge current-head">当前本地 HEAD</span>}<span className={`commit-badge ${kind}`} title="本地指当前 Worktree HEAD 可达历史；远程指已获取的全部远程跟踪引用可达历史。">{label}</span></span>;
}

function Graph({ commits, selected, head, onSelect, onWorktree }: { commits: GitGraphCommit[]; selected?: string; head?: string | null; onSelect(hash: string): void; onWorktree(id: string): void }) {
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  return <div className="commit-graph" style={{ "--graph-width": `${layout.width}px` } as React.CSSProperties}><svg width={layout.width} height={commits.length * graphRowHeight + 12} aria-hidden="true">{layout.edges.map((edge, i) => <path key={i} d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${edge.y2}`} stroke={graphColor(edge.color)} fill="none" strokeWidth="1.5" strokeDasharray={edge.continued ? "3 3" : undefined}/>)}{layout.nodes.map(node => <circle key={node.hash} cx={node.x} cy={node.y} r={node.hash === head ? 5.5 : 3.5} fill={node.hash === head ? "#8bb6ff" : "#111419"} stroke={graphColor(node.lane)} strokeWidth="2"/>)}</svg><div className="graph-rows">{commits.map(commit => <div data-commit={commit.hash} className={`graph-commit ${selected === commit.hash ? "selected" : ""} ${head === commit.hash ? "local-head" : ""}`} key={commit.hash}>
    <button title={commit.subject} aria-pressed={selected === commit.hash} onClick={() => onSelect(commit.hash)}><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code> {commit.authorName} · {new Date(commit.committedAt).toLocaleDateString()}</span></button>
    <div className="graph-row-labels"><CommitBadges commit={commit} head={head}/><div className="graph-decorations">{commit.decorations.map((decoration, i) => <button className={decoration.type} key={i} title={decoration.worktreeId ? "查看 Worktree 详情" : decoration.name} onClick={() => decoration.worktreeId ? onWorktree(decoration.worktreeId) : onSelect(commit.hash)}>{decoration.name}</button>)}</div></div>
  </div>)}</div></div>;
}

function layoutCommitGraph(commits: GitGraphCommit[]) {
  const lanes: string[] = [], positions = new Map<string, { lane: number; row: number }>();
  for (const [row, commit] of commits.entries()) {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.findIndex(value => !value); if (lane < 0) lane = lanes.length; lanes[lane] = commit.hash; }
    positions.set(commit.hash, { lane, row });
    lanes[lane] = "";
    for (const [index, parent] of commit.parents.entries()) if (!lanes.includes(parent)) {
      let target = index === 0 && !lanes[lane] ? lane : lanes.findIndex(value => !value);
      if (target < 0) target = lanes.length; lanes[target] = parent;
    }
  }
  const width = Math.max(42, (Math.max(0, ...[...positions.values()].map(p => p.lane)) + 1) * 16 + 20);
  const nodes = [...positions].map(([hash, p]) => ({ hash, lane: p.lane, x: 14 + p.lane * 16, y: p.row * graphRowHeight + 27 }));
  const edges = commits.flatMap(c => c.parents.map(parent => { const from = positions.get(c.hash)!, to = positions.get(parent); return { x1: 14 + from.lane * 16, y1: from.row * graphRowHeight + 27, x2: 14 + (to?.lane ?? from.lane) * 16, y2: to ? to.row * graphRowHeight + 27 : commits.length * graphRowHeight + 10, color: to?.lane ?? from.lane, continued: !to }; }));
  return { width, nodes, edges };
}
const graphColor = (index: number) => ["#8bb6ff", "#b4a1db", "#8ecba8", "#e7bd7d", "#df9ebc", "#88c8d4"][index % 6];

function CommitDetails({ detail, diff }: { detail: GitCommitDetail; diff(hash: string, path?: string): void }) {
  const [copyNotice, setCopyNotice] = useState("");
  useEffect(() => setCopyNotice(""), [detail.hash]);
  return <div className="commit-detail"><small>提交详情</small><h3>{detail.subject}</h3><div className="commit-hash"><code title={detail.hash}>{detail.hash.slice(0, 12)}</code><button aria-label="复制提交哈希" onClick={async () => {
    try { await navigator.clipboard.writeText(detail.hash); setCopyNotice("已复制"); } catch { setCopyNotice(`提交哈希：${detail.hash}`); }
  }}><Copy size={14}/></button></div>{copyNotice && <small role="status">{copyNotice}</small>}<p>{detail.body}</p><div className="commit-meta">{detail.authorName}<br/>{new Date(detail.committedAt).toLocaleString()}{detail.parents.length > 1 && <><br/>合并提交 · 相对第一父提交</>}</div>
    <section className="commit-files"><h4>修改文件 <span>{detail.files.length} 个</span></h4><div className="commit-diff-stats"><span className="diff-additions">+{detail.additions} 新增</span><span className="diff-deletions">−{detail.deletions} 删除</span></div>{detail.files.map(file => <button className="commit-file" key={file.path} title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => diff(detail.hash, file.path)}><em>{file.status[0]}</em><span>{file.path.split("/").at(-1)}<small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "."}</small></span><ChevronRight size={14}/></button>)}<button className="workbench-primary" disabled={!detail.files.length} onClick={() => diff(detail.hash)}><GitCompareArrows size={15}/>查看全部差异</button></section>
  </div>;
}

export function WorktreePanel({ onNavigate, focusWorktree, focusRequest = 0, scope: scopeProp, onScopeChange, active = true }: {
  onNavigate(worktree: GitWorktree, target: "history" | "changes"): void;
  focusWorktree?: string;
  focusRequest?: number;
  scope?: string;
  onScopeChange?(scope: string): void;
  active?: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["git", "worktrees"], queryFn: api.worktrees, retry: false, enabled: active });
  const [filter, setFilter] = useState("all"), [selected, setSelected] = useState(focusWorktree);
  const [search, setSearch] = useState(""), [localScope, setLocalScope] = useState("all");
  const [previewId, setPreviewId] = useState<string>();
  const scope = scopeProp ?? localScope;
  const setScope = (value: string) => { setLocalScope(value); onScopeChange?.(value); };
  useEffect(() => {
    if (focusWorktree) { setSelected(focusWorktree); setFilter("all"); setSearch(""); setLocalScope("all"); onScopeChange?.("all"); }
  }, [focusWorktree, focusRequest]);
  useEffect(() => {
    if (!selected || !active) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !previewId) setSelected(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected, active, previewId]);
  const rows = (query.data?.groups.flatMap(group => group.worktrees.map(worktree => ({ group, worktree }))) ?? [])
    .sort((a, b) => stateRank(a.worktree) - stateRank(b.worktree) || a.group.name.localeCompare(b.group.name) || a.worktree.path.localeCompare(b.worktree.path));
  const totals = { all: rows.length, dirty: rows.filter(row => stateRank(row.worktree) === 0).length, clean: rows.filter(row => stateRank(row.worktree) === 1).length, unknown: rows.filter(row => stateRank(row.worktree) === 2).length };
  const collections = groupByGitAddress(query.data?.groups ?? []);
  const scopeGroups = new Set(collections.filter(c => scope === "all" || c.key === scope || c.bases.some(base => `base:${base.repositoryGroupId}` === scope)).flatMap(c => c.bases.filter(base => !scope.startsWith("base:") || `base:${base.repositoryGroupId}` === scope).map(base => base.repositoryGroupId)));
  const scopedRows = rows.filter(row => scopeGroups.has(row.group.repositoryGroupId));
  const visible = scopedRows.filter(({ worktree }) => (filter === "all" || stateRank(worktree) === ({ dirty: 0, clean: 1, unknown: 2 })[filter as "dirty" | "clean" | "unknown"]) && (!search || `${worktree.path} ${worktree.branch ?? ""}`.toLowerCase().includes(search.toLowerCase())));
  const visibleIds = new Set(visible.map(row => row.worktree.worktreeId));
  const selection = visible.find(row => row.worktree.worktreeId === selected);
  const worktree = selection?.worktree;
  const scopeName = scope === "all" ? "全部仓库" : collections.find(c => c.key === scope)?.name ?? rows.find(row => `base:${row.group.repositoryGroupId}` === scope)?.group.name ?? "所选仓库";
  return <div className="worktree-page workbench-page">
    <header className="workbench-page-title"><div><h1>Worktree</h1><p>{scopeName} <span>／</span> 工作目录总览</p></div><button onClick={() => client.invalidateQueries({ queryKey: ["git"] })}><RefreshCw size={14}/>刷新状态</button></header>
    <div className="worktree-toolbar">
      <div className="worktree-totals" aria-label="Worktree 全局统计">{([['all', '全部 Worktree'], ['dirty', '有修改'], ['clean', '干净'], ['unknown', '未知']] as const).map(([key, label]) => <button key={key} className={`worktree-stat ${key}`} aria-pressed={filter === key} onClick={() => setFilter(key)}><span>{label}</span><strong>{query.data ? totals[key] : "—"}</strong></button>)}</div>
      <label className="worktree-search"><Search size={14}/><span className="sr-only">搜索目录或分支</span><input aria-label="搜索目录或分支" placeholder="搜索目录或分支…" value={search} onChange={e => setSearch(e.target.value)}/></label>
      <label className="sr-only">文件状态筛选<select aria-label="Worktree 文件状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="dirty">有修改</option><option value="clean">干净</option><option value="unknown">未知</option></select></label>
    </div>
    <select className="worktree-mobile-scope" aria-label="筛选仓库" value={scope} onChange={e => setScope(e.target.value)}><option value="all">全部仓库</option>{collections.map(c => <optgroup label={c.name} key={c.key}><option value={c.key}>{c.name} · 全部本地仓库</option>{c.bases.map(base => <option key={base.repositoryGroupId} value={`base:${base.repositoryGroupId}`}>{base.name} · {base.commonDir}</option>)}</optgroup>)}</select>
    <div className="worktree-scope-caption">当前范围 {visible.length} / {scopedRows.length} 个工作目录 · 状态统计基于全部登记项</div>
    {query.isError && <p className="error" role="alert">{errorText(query.error)}</p>}{query.isLoading && <p className="panel-empty">正在读取登记和状态…</p>}
    {query.data?.groups.filter(group => group.error || group.truncated).map(group => <p className="error" key={group.repositoryGroupId}>{group.name}：{group.error || "登记清单超过限制，统计仅包含已读取项"}</p>)}
    <div className={`worktree-layout ${worktree ? "with-detail" : ""}`}><div className="worktree-collections">{collections.filter(c => c.bases.some(base => base.worktrees.some(w => visibleIds.has(w.worktreeId)))).map(collection => {
      const members = collection.bases.flatMap(base => base.worktrees);
      const extraAddresses = new Set(collection.bases.flatMap(base => base.remote?.remotes.flatMap(remote => [...remote.fetchUrls, ...remote.pushUrls]) ?? []).filter(url => url !== collection.url));
      return <section className="git-address-group" key={collection.key} aria-label={`Git 地址：${collection.url ?? collection.bases[0].name}`}><header className="git-address-header"><div><FolderGit2 size={15}/><strong>{collection.name}</strong><details><summary title={collection.url ?? "未配置远程"}><ChevronDown size={13}/>远程信息</summary><code>{collection.url ?? (collection.bases[0].remote?.error ? "地址读取失败" : "未配置远程 · 本地仓库")}</code>{extraAddresses.size > 0 && <details className="git-extra-addresses"><summary>其他 Git 地址 · {extraAddresses.size} 个</summary>{collection.bases.map(base => <RemoteAddresses key={base.repositoryGroupId} remote={base.remote}/>)}</details>}</details></div><small>{collection.bases.length} 个本地仓库 · {members.length} 个 Worktree · 修改 {members.filter(w => stateRank(w) === 0).length} / 干净 {members.filter(w => stateRank(w) === 1).length} / 未知 {members.filter(w => stateRank(w) === 2).length}</small></header>
        {collection.bases.filter(base => base.worktrees.some(w => visibleIds.has(w.worktreeId))).map(base => <section className="worktree-base" aria-label={`本地仓库：${base.name}`} data-base={base.repositoryGroupId} key={base.repositoryGroupId}>
          <div className="worktree-base-header"><strong>本地仓库 · {base.name}</strong><code title={base.commonDir}>{base.commonDir}</code><span>{base.worktrees.length} 个</span></div>{base.remote?.error && <p className="error">{base.remote.error}</p>}
          <div className="worktree-table" role="table" aria-label={`${base.name} Worktree 列表`}><div className="worktree-table-head" role="row"><span role="columnheader">工作目录 / 分支</span><span role="columnheader">文件状态</span><span role="columnheader" title="未被已获取的远程引用包含的提交">未发布</span><span/></div>{base.worktrees.filter(w => visibleIds.has(w.worktreeId)).sort((a, b) => stateRank(a) - stateRank(b) || a.path.localeCompare(b.path)).map(w => <WorktreeRow key={w.worktreeId} worktree={w} selected={selected === w.worktreeId} onSelect={() => setSelected(selected === w.worktreeId ? undefined : w.worktreeId)}/>)}</div>
        </section>)}
      </section>;
    })}{query.data && visible.length === 0 && <p className="panel-empty">当前筛选下没有 Worktree。</p>}</div>
      {worktree && selection && <aside className="worktree-detail" aria-label="Worktree 详情"><div className="worktree-detail-title"><div><small>工作目录详情</small><h3>{worktree.path.split(/[\\/]/).at(-1)}</h3></div><button aria-label="关闭 Worktree 详情" title="关闭（Esc）" onClick={() => setSelected(undefined)}><X size={17}/></button></div>
        <div className="worktree-detail-tags">{worktree.current && <span className="worktree-badge current">当前 Git 上下文</span>}<span className="worktree-badge">{worktree.main === true ? "主工作区" : worktree.main === false ? "关联 Worktree" : "主身份未知"}</span>{!worktree.inWorkspace && <span className="worktree-badge">工作区外 · 只读</span>}{worktree.missing && <span className="worktree-badge">目录缺失</span>}{worktree.locked !== undefined && <span className="worktree-badge">已锁定</span>}</div>
        <div className="worktree-detail-branch"><GitBranch size={15}/><strong>{worktree.branch ?? (worktree.bare ? "裸仓库" : "detached HEAD")}</strong></div><small>HEAD {worktree.head?.slice(0, 8) ?? "无"} · {new Date(worktree.readAt).toLocaleTimeString()}</small>
        <section className="worktree-detail-section"><h4>文件状态<span className={worktree.status?.clean ? "state-clean" : "state-dirty"}>{!worktree.status ? "未知" : worktree.status.clean ? "干净" : `${worktree.status.files.length} 个文件`}</span></h4>{worktree.status ? <div className="worktree-file-counts">{([['staged', '已暂存'], ['unstaged', '未暂存'], ['untracked', '未跟踪'], ['conflicted', '冲突']] as const).filter(([key]) => key !== "conflicted" || worktree.status!.counts.conflicted > 0).map(([key, label]) => <div key={key}><strong>{worktree.status!.counts[key]}</strong><small>{label}</small></div>)}</div> : <p className="boundary-note">{worktree.error ?? "文件状态尚未读取，刷新状态后重试。"}</p>}
          {worktree.repositoryId && !worktree.missing && <button className="workbench-primary" onClick={() => onNavigate(worktree, worktree.status?.clean ? "history" : "changes")}><GitCompareArrows size={15}/>{worktree.status?.clean ? "查看历史" : "查看修改"}</button>}
        </section>
        <section className="worktree-detail-section"><h4>提交与远程</h4><dl><dt>未发布提交</dt><dd>{worktree.unpublished === null ? "未知" : `${worktree.unpublished} 个`}</dd><dt>相对上游分支</dt><dd>{worktree.upstream ? `↑ ${worktree.upstream.ahead} 领先 / ↓ ${worktree.upstream.behind} 落后` : "未配置 / 未知"}</dd></dl>{worktree.upstream && <small>{worktree.upstream.ref.replace(/^refs\/remotes\//, "")}</small>}<button className="worktree-history-link" disabled={!worktree.head} onClick={() => onNavigate(worktree, "history")}><GitGraph size={15}/>定位提交图<ArrowUpRight size={13}/></button></section>
        <details className="worktree-path-details"><summary><ChevronRight size={14}/>目录与远程信息</summary><dl><dt>工作目录</dt><dd><code>{worktree.path}</code></dd><dt>本地仓库（共享 Git 数据）</dt><dd><code>{selection.group.commonDir}</code></dd><dt>远程地址</dt><dd><RemoteAddresses remote={selection.group.remote}/></dd><dt>默认分支关系</dt><dd>{worktree.defaultBranch ?? "未知"} · {({ equal: "相同", ancestor: "祖先", descendant: "后代", diverged: "已分叉", unknown: "未知" })[worktree.defaultRelation]}</dd></dl><small>{worktree.syncNote}</small></details>
        <button className="worktree-preview-button" onClick={() => setPreviewId(worktree.worktreeId)}><ScanLine size={14}/>清理预览</button><small className="worktree-preview-note">仅评估条件，保留分支与提交</small>
      </aside>}
    </div>
    <p className="workbench-footnote">文件改动与提交发布状态分别展示 · 未发布 = 已获取的远程引用尚未包含的提交</p>
    {active && previewId && <RemovalDialog worktreeId={previewId} close={() => setPreviewId(undefined)}/>}
  </div>;
}

type WorktreeBase = WorktreeOverview["groups"][number];
export function groupByGitAddress(groups: WorktreeBase[]) {
  const result = new Map<string, { key: string; url: string | null; name: string; bases: WorktreeBase[] }>();
  const baseRank = (base: WorktreeBase) => Math.min(2, ...base.worktrees.map(stateRank));
  for (const base of groups) {
    const url = base.remote?.primaryUrl ?? null;
    // Group presentation only: independent common-dir identities still define operation scope.
    const key = url && !base.remote.error ? `remote:${url}` : `base:${base.repositoryGroupId}`;
    const name = url?.replace(/\/+$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/, "") || base.name;
    const collection = result.get(key) ?? { key, url, name, bases: [] };
    collection.bases.push(base); result.set(key, collection);
  }
  return [...result.values()].map(collection => ({ ...collection, bases: [...collection.bases].sort((a, b) => baseRank(a) - baseRank(b) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => Math.min(...a.bases.map(baseRank)) - Math.min(...b.bases.map(baseRank)) || a.name.localeCompare(b.name));
}

function RemoteAddresses({ remote }: { remote?: GitRemoteAddresses }) {
  if (remote?.error) return <p className="error">{remote.error}</p>;
  if (!remote?.remotes.length) return <small>未配置远程，按本地仓库展示。</small>;
  return <div className="git-remote-addresses">{remote.remotes.map(r => <div key={r.name}>{r.fetchUrls.map(url => <div key={`fetch:${url}`}><span>{r.name} · fetch</span><code>{url}</code></div>)}{r.pushUrls.filter(url => !r.fetchUrls.includes(url)).map(url => <div key={`push:${url}`}><span>{r.name} · push</span><code>{url}</code></div>)}</div>)}</div>;
}

function WorktreeRow({ worktree: w, selected, onSelect }: { worktree: WorktreeStatus; selected: boolean; onSelect(): void }) {
  return <button role="row" aria-label={`${w.workspacePath ?? w.path} · ${stateText(w)}`} aria-expanded={selected} data-worktree={w.worktreeId} data-state={['dirty', 'clean', 'unknown'][stateRank(w)]} className={`worktree-row ${selected ? "selected" : ""}`} onClick={onSelect}>
    <span role="cell" className="worktree-directory"><span className="worktree-name"><strong title={w.path}>{w.path.split(/[\\/]/).at(-1) || w.path}</strong>{w.main === true && <span className="worktree-badge main">主工作区</span>}{w.current && <span className="worktree-badge current">当前</span>}</span><span className="worktree-branch" title={w.branch ?? "detached HEAD"}><GitBranch size={12}/><span>{w.branch ?? (w.bare ? "裸仓库" : "detached HEAD")}</span></span></span>
    <span role="cell" className={`worktree-file-state ${['dirty', 'clean', 'unknown'][stateRank(w)]}`}>{!w.status ? <CircleHelp size={14}/> : w.status.clean ? <Check size={14}/> : <CircleDot size={14}/>}<strong>{!w.status ? "未知" : w.status.clean ? "干净" : `${w.status.files.length} 个文件`}</strong>{w.locked !== undefined && <small>已锁定</small>}{w.prunable !== undefined && <small>登记失效</small>}</span>
    <span role="cell" className={`worktree-unpublished ${w.unpublished ? "has-value" : ""}`} title="未被已获取的远程引用包含的提交">{w.unpublished ?? "—"}</span><ChevronRight size={14}/>
  </button>;
}
function stateRank(w: WorktreeStatus) { return !w.status ? 2 : w.status.clean ? 1 : 0; }
function stateText(w: WorktreeStatus) { return !w.status ? `状态未知：${w.error ?? "尚未读取"}` : w.status.clean ? "文件干净" : `有修改 ${w.status.files.length} · 暂存 ${w.status.counts.staged} / 未暂存 ${w.status.counts.unstaged} / 未跟踪 ${w.status.counts.untracked} / 冲突 ${w.status.counts.conflicted}`; }

function RemovalDialog({ worktreeId, close }: { worktreeId: string; close(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const query = useQuery({ queryKey: ["git", "removal-preview", worktreeId], queryFn: async () => {
    const state = useAppStore.getState();
    if (state.workspace) await api.editorState(state.workspace.id, state.tabs.flatMap(tab => tab.type === "text" || tab.type === "image" ? [tab.path] : []), state.tabs.flatMap(tab => tab.type === "text" && tab.dirty ? [tab.path] : []));
    return api.removalPreview(worktreeId);
  }, retry: false, staleTime: Infinity, gcTime: 0 });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);
  const preview = query.data;
  return <div className="workbench-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="workbench-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="removal-title" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") {
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}><header><h2 id="removal-title">清理预览</h2><button ref={closeButton} aria-label="关闭清理预览" onClick={close}><X size={17}/></button></header>
    {query.isPending ? <p>正在检查文件、提交与会话状态…</p> : query.isError ? <p className="error" role="alert">{errorText(query.error)}</p> : preview && <>
      <p>{preview.worktree.branch ?? "detached HEAD"}</p><strong className={preview.allowed ? "state-clean" : "state-dirty"}>{preview.allowed ? "符合关联 Worktree 清理条件" : "当前不满足清理条件"}</strong>
      <dl><dt>保留分支</dt><dd>{preview.branchPreserved ?? "detached；由已有引用保留提交"}</dd><dt>忽略内容</dt><dd>{preview.ignoredCount ?? "未知"}</dd><dt>未保存文件</dt><dd>{preview.unsavedCount}</dd><dt>其他会话</dt><dd>{preview.otherSessionCount}</dd></dl>
      {preview.reasons.map(reason => <p className="error" key={reason}>{reason}</p>)}{preview.warnings.map(warning => <p className="boundary-note" key={warning}>{warning}</p>)}
    </>}
    <p className="workbench-footnote">只读评估，不移除目录；实际清理前仍需重新检查状态。</p><footer><button onClick={close}>知道了</button></footer>
  </div></div>;
}
