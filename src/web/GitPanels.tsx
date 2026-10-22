import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, GitBranch, Maximize2, Minimize2, X } from "lucide-react";
import type { GitCommitDetail, GitGraphCommit, GitHistoryPage, GitRemoteAddresses, GitRepositoryInfo, GitWorktree, HistoryScope, RemovalPreview, WorktreeOverview, WorktreeStatus } from "../shared/contracts";
import { api, ApiClientError } from "./api";
import { useAppStore } from "./store";

const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败";

export function SyncControl({ repositoryGroupId }: { repositoryGroupId: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const overview = useQuery({ queryKey: ["git", "sync", repositoryGroupId], queryFn: () => api.sync(repositoryGroupId), staleTime: 10000 });
  const sync = overview.data;
  return <div className="sync-control"><div className="git-actions"><button disabled={busy} onClick={async () => {
    setBusy(true); setError("");
    try { await api.fetch(repositoryGroupId); await client.invalidateQueries({ queryKey: ["git"] }); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }}>{busy ? "正在同步远程…" : "同步远程"}</button><button onClick={() => client.invalidateQueries({ queryKey: ["git"] })}>刷新本地快照</button></div>
    {error && <p className="error">{error}</p>}{!sync ? <small>本地快照 · 尚未同步远程</small> : sync.remotes.length === 0 ? <small>未配置远程</small> : sync.remotes.map(r => <small className={r.success ? "" : "error"} key={r.name}>{r.name}：{r.success ? "同步成功" : r.error} · {new Date(r.finishedAt).toLocaleTimeString()}{r.lastSuccessAt && <span> · 上次成功 {new Date(r.lastSuccessAt).toLocaleString()}</span>}</small>)}
  </div>;
}

export function HistoryPanel({ repository, onDiff, focusHash, onWorktree }: { repository: GitRepositoryInfo | null; onDiff(hash: string, path?: string): void; focusHash?: string; onWorktree(id: string): void }) {
  const [mode, setMode] = useState<"list" | "graph">("graph");
  const [scope, setScope] = useState<HistoryScope>("all"), [ref, setRef] = useState("");
  const [selected, setSelected] = useState(focusHash), [pages, setPages] = useState<GitHistoryPage[]>([]);
  const [loading, setLoading] = useState(false), [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false), [locateRequest, setLocateRequest] = useState(0);
  const panel = useRef<HTMLElement>(null), expandButton = useRef<HTMLButtonElement>(null);
  const refs = useQuery({ queryKey: ["git", "refs", repository?.id], queryFn: () => api.refs(repository!.id), enabled: Boolean(repository) });
  const first = useQuery({ queryKey: ["git", "graph", repository?.id, scope, ref], queryFn: () => api.graph(0, repository!.id, { scope, ...(scope === "ref" ? { ref } : {}) }), enabled: Boolean(repository) && (scope !== "ref" || Boolean(ref)), retry: false });
  useEffect(() => { setPages([]); }, [scope, ref, repository?.id]);
  useEffect(() => { if (focusHash) setSelected(focusHash); }, [focusHash]);
  const currentPages = first.data ? [first.data, ...pages.filter(p => p.graphRevision === first.data.graphRevision)] : [];
  const commits = currentPages.flatMap(p => p.items);
  const next = currentPages.at(-1)?.nextCursor;
  const detail = useQuery({ queryKey: ["git", "commit", repository?.id, selected], queryFn: () => api.commit(selected!, repository!.id), enabled: Boolean(repository && selected), retry: false });
  useEffect(() => {
    if (!expanded) return;
    const exit = (event: KeyboardEvent) => { if (event.key === "Escape") { setExpanded(false); expandButton.current?.focus(); } };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [expanded]);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-commit="${selected}"]`)?.scrollIntoView?.({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [focusHash, mode, expanded, first.data?.graphRevision, locateRequest]);
  if (!repository) return <p className="panel-empty">未发现 Git 项目</p>;
  const head = first.data?.head;
  const comparison = first.data?.comparison;
  const openWorktree = (id: string) => { setExpanded(false); onWorktree(id); };
  return <section ref={panel} className={`history-panel ${expanded ? "history-fullscreen" : ""}`} aria-label="Git 历史面板"><div className="panel-title"><strong>Git 历史</strong><span><button title="提交图" onClick={() => setMode("graph")} aria-pressed={mode === "graph"}>图</button><button title="线性列表" onClick={() => setMode("list")} aria-pressed={mode === "list"}>列表</button><button ref={expandButton} className="history-expand" aria-label={expanded ? "退出全屏" : "全屏查看 Git 历史"} title={expanded ? "退出全屏（Esc）" : "全屏查看"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}<span>{expanded ? "退出全屏" : "全屏"}</span></button></span></div>
    <div className="repo-summary"><strong>{repository.workspacePath || repository.name}</strong><small>{repository.branch ?? "detached"}</small></div>
    <div className="history-local-summary"><div><span className="commit-badge current-head">当前本地 HEAD</span><code>{head?.slice(0, 8) ?? (first.isLoading ? "读取中…" : "无提交")}</code><button disabled={!head} onClick={() => {
      setSelected(head!); setLocateRequest(n => n + 1);
      if (!commits.some(c => c.hash === head)) { setScope("current"); setNotice("已切到当前 worktree 分支，定位本地 HEAD"); }
    }}>定位</button></div><small>{comparison?.upstream ? <>{comparison.upstream} · 本地领先 <b>{comparison.ahead ?? "?"}</b> / 落后 <b>{comparison.behind ?? "?"}</b></> : "未配置 upstream，无法比较跟踪分支"}</small></div>
    <SyncControl repositoryGroupId={repository.repositoryGroupId}/>
    <div className="history-scope"><label>历史范围<select aria-label="历史范围" value={scope} onChange={e => { setScope(e.target.value as HistoryScope); setNotice(""); }}><option value="all">全部分支 / Tag / worktree HEAD</option><option value="current">当前 worktree 分支</option><option value="ref">指定引用</option></select></label>{scope === "ref" && <select aria-label="指定引用" value={ref} onChange={e => setRef(e.target.value)}><option value="">选择分支或 Tag</option>{refs.data?.map(r => <option key={r.fullName} value={r.fullName}>{r.kind} · {r.name}</option>)}</select>}</div>
    {first.isError && <p className="error">{errorText(first.error)}</p>}
    {first.data?.shallow && <p className="boundary-note">浅仓库：历史在浅克隆边界截断</p>}
    <div className="history-progress">已加载 {commits.length} / {first.data?.total ?? "…"} · {Math.max(0, (first.data?.total ?? 0) - commits.length)} 条待加载</div>
    <div className="history-legend"><span className="commit-badge local-only">本地独有</span><span className="commit-badge shared">本地 / 远程共有</span><span className="commit-badge remote-only">远程独有</span><small>相对当前 HEAD 与全部已获取远程引用；浅仓库以已知历史为准。</small></div>
    {notice && <p className="boundary-note">{notice}</p>}
    {selected && !commits.some(c => c.hash === selected) && <p className="boundary-note">所选提交不在已加载范围中，可加载更多或切回全部范围。</p>}
    <div className="history-workbench"><div className="history-picker">{mode === "graph" ? <Graph commits={commits} selected={selected} head={head} onSelect={setSelected} onWorktree={openWorktree}/> : <div className="history-list">{commits.map(commit => <button data-commit={commit.hash} key={commit.hash} className={`${selected === commit.hash ? "selected" : ""} ${head === commit.hash ? "local-head" : ""}`} onClick={() => setSelected(commit.hash)}><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code>{commit.authorName}</span><CommitBadges commit={commit} head={head}/></button>)}</div>}
      {next != null && <button className="wide-action" disabled={loading} onClick={async () => {
        setLoading(true);
        try {
          const page = await api.graph(next, repository.id, { scope, ...(scope === "ref" ? { ref } : {}), graphRevision: first.data!.graphRevision });
          setPages(p => [...p, page]);
        } catch (error) {
          if (error instanceof ApiClientError && error.code === "GRAPH_CHANGED") { setPages([]); setNotice("引用已变化，已重新加载第一页"); await first.refetch(); }
          else setNotice(errorText(error));
        } finally { setLoading(false); }
      }}>{loading ? "加载中…" : "加载更多提交"}</button>}
    </div><div className="history-detail">{detail.data ? <CommitDetails detail={detail.data} diff={(hash, path) => { setExpanded(false); onDiff(hash, path); }}/> : selected ? <p className="panel-empty">{detail.isError ? errorText(detail.error) : "加载提交详情…"}</p> : <p className="panel-empty">选择提交查看详情</p>}</div></div>
  </section>;
}

function CommitBadges({ commit, head }: { commit: GitGraphCommit; head?: string | null }) {
  const local = commit.inCurrentHistory, remote = commit.inRemoteHistory;
  const kind = local === null || remote === null ? "unknown" : local ? remote ? "shared" : "local-only" : remote ? "remote-only" : "other-history";
  const label = ({ shared: "本地 / 远程共有", "local-only": "本地独有", "remote-only": "远程独有", "other-history": "其他本地引用", unknown: "远程 / 归属未知" })[kind];
  return <span className="commit-badges">{commit.hash === head && <span className="commit-badge current-head">当前本地 HEAD</span>}<span className={`commit-badge ${kind}`} title="本地指当前 worktree HEAD 可达历史；远程指已获取的全部远程跟踪引用可达历史。">{label}</span></span>;
}

function Graph({ commits, selected, head, onSelect, onWorktree }: { commits: GitGraphCommit[]; selected?: string; head?: string | null; onSelect(hash: string): void; onWorktree(id: string): void }) {
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  return <div className="commit-graph" style={{ "--graph-width": `${layout.width}px` } as React.CSSProperties}><svg width={layout.width} height={commits.length * 84 + 12} aria-hidden="true">{layout.edges.map((e, i) => <path key={i} d={`M ${e.x1} ${e.y1} C ${e.x1} ${(e.y1 + e.y2) / 2}, ${e.x2} ${(e.y1 + e.y2) / 2}, ${e.x2} ${e.y2}`} stroke={graphColor(e.color)} fill="none" strokeWidth="2" strokeDasharray={e.continued ? "3 3" : undefined}/>)}{layout.nodes.map(n => <circle key={n.hash} cx={n.x} cy={n.y} r={n.hash === head ? 7 : 4.5} fill={n.hash === head ? "#3fb950" : "#11161d"} stroke={n.hash === head ? "#aff5b4" : graphColor(n.lane)} strokeWidth="2.5"/>)}</svg><div className="graph-rows">{commits.map(commit => <div data-commit={commit.hash} className={`graph-commit ${selected === commit.hash ? "selected" : ""} ${head === commit.hash ? "local-head" : ""}`} key={commit.hash}><button title={commit.subject} onClick={() => onSelect(commit.hash)}><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code> {commit.authorName}</span></button><CommitBadges commit={commit} head={head}/><div className="graph-decorations">{commit.decorations.map((d, i) => <button className={d.type} key={i} title={d.worktreeId ? "查看 worktree 摘要" : d.type} onClick={() => d.worktreeId ? onWorktree(d.worktreeId) : onSelect(commit.hash)}>{d.name}</button>)}</div></div>)}</div></div>;
}

function layoutCommitGraph(commits: GitGraphCommit[]) {
  const lanes: string[] = [], positions = new Map<string, { lane: number; row: number }>();
  for (const [row, commit] of commits.entries()) {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.findIndex(x => !x); if (lane < 0) lane = lanes.length; lanes[lane] = commit.hash; }
    positions.set(commit.hash, { lane, row });
    lanes[lane] = "";
    for (const [index, parent] of commit.parents.entries()) if (!lanes.includes(parent)) {
      let target = index === 0 && !lanes[lane] ? lane : lanes.findIndex(x => !x);
      if (target < 0) target = lanes.length; lanes[target] = parent;
    }
  }
  const width = Math.max(42, (Math.max(0, ...[...positions.values()].map(p => p.lane)) + 1) * 16 + 20);
  const nodes = [...positions].map(([hash, p]) => ({ hash, lane: p.lane, x: 14 + p.lane * 16, y: p.row * 84 + 30 }));
  const edges = commits.flatMap(c => c.parents.map(parent => { const from = positions.get(c.hash)!, to = positions.get(parent); return { x1: 14 + from.lane * 16, y1: from.row * 84 + 30, x2: 14 + (to?.lane ?? from.lane) * 16, y2: to ? to.row * 84 + 30 : commits.length * 84 + 10, color: to?.lane ?? from.lane, continued: !to }; }));
  return { width, nodes, edges };
}
const graphColor = (index: number) => ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf"][index % 6];
function CommitDetails({ detail, diff }: { detail: GitCommitDetail; diff(hash: string, path?: string): void }) {
  return <div className="commit-detail"><h3>{detail.subject}</h3><code>{detail.hash}</code><p>{detail.body}</p><div className="commit-meta">{detail.authorName} · {new Date(detail.committedAt).toLocaleString()} · +{detail.additions} -{detail.deletions}{detail.parents.length > 1 && " · 相对第一父提交"}</div><button className="wide-action" onClick={() => diff(detail.hash)}>在编辑区查看全部 Diff（{detail.files.length} 文件）</button>{detail.files.map(f => <button className="commit-file" key={f.path} onClick={() => diff(detail.hash, f.path)}><em>{f.status[0]}</em><span>{f.path}</span></button>)}</div>;
}

export function WorktreePanel({ onNavigate, focusWorktree }: { onNavigate(worktree: GitWorktree, target: "history" | "changes"): void; focusWorktree?: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["git", "worktrees"], queryFn: api.worktrees, retry: false });
  const [filter, setFilter] = useState("all"), [selected, setSelected] = useState(focusWorktree);
  const [preview, setPreview] = useState<RemovalPreview>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { if (focusWorktree) setSelected(focusWorktree); }, [focusWorktree]);
  useEffect(() => { setPreview(undefined); setError(""); }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);
  const rows = (query.data?.groups.flatMap(group => group.worktrees.map(worktree => ({ group, worktree }))) ?? [])
    .sort((a, b) => stateRank(a.worktree) - stateRank(b.worktree) || a.group.name.localeCompare(b.group.name) || a.worktree.path.localeCompare(b.worktree.path));
  const totals = {
    all: rows.length,
    dirty: rows.filter(r => stateRank(r.worktree) === 0).length,
    clean: rows.filter(r => stateRank(r.worktree) === 1).length,
    unknown: rows.filter(r => stateRank(r.worktree) === 2).length
  };
  const visible = rows.filter(({ worktree }) => filter === "all" || stateRank(worktree) === ({ dirty: 0, clean: 1, unknown: 2 })[filter as "dirty" | "clean" | "unknown"]);
  const visibleIds = new Set(visible.map(r => r.worktree.worktreeId));
  const collections = groupByGitAddress(query.data?.groups ?? []);
  const mains = rows.filter(r => r.worktree.main === true);
  const selection = rows.find(r => r.worktree.worktreeId === selected);
  const worktree = selection?.worktree;
  async function inspect() {
    if (!worktree) return; setBusy(true); setError("");
    try {
      const state = useAppStore.getState();
      await api.editorState(state.workspace!.id, state.tabs.flatMap(t => t.type === "text" || t.type === "image" ? [t.path] : []), state.tabs.flatMap(t => t.type === "text" && t.dirty ? [t.path] : []));
      setPreview(await api.removalPreview(worktree.worktreeId));
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="worktree-page"><header><div><h2>Worktree 关系图</h2><p>{query.data?.groups.length ?? "…"} 个本地 base · 按 Git 地址分组，组内按修改、干净、未知排序 · 点击一项查看详情</p></div><button onClick={() => client.invalidateQueries({ queryKey: ["git"] })}>刷新本地快照</button></header>
    <div className="worktree-totals" aria-label="Worktree 全局统计">{([['all', '全部 Worktree'], ['dirty', '有修改'], ['clean', '干净'], ['unknown', '未知']] as const).map(([key, label]) => <button key={key} className={`worktree-stat ${key}`} aria-pressed={filter === key} onClick={() => setFilter(key)}><span>{label}</span><strong>{query.data ? totals[key] : "—"}</strong></button>)}</div>
    {query.data && <details className="main-workspaces"><summary>主工作区 · {mains.length} 个<span>展开查看目录与分支</span></summary><div>{mains.map(({ group, worktree: w }) => <button key={w.worktreeId} onClick={() => setSelected(w.worktreeId)}><strong>{group.name}</strong><span>{w.branch ?? "detached HEAD"}</span><code>{w.path}</code></button>)}{!mains.length && <p>当前登记结果中没有已确认的主工作区。</p>}</div></details>}
    <div className="worktree-toolbar"><label>文件状态筛选 <select aria-label="Worktree 文件状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="dirty">有修改</option><option value="clean">干净</option><option value="unknown">未知</option></select></label><small>显示 {visible.length} / {rows.length} 个 · 统计始终基于全部登记项</small></div>
    {query.isError && <p className="error">{errorText(query.error)}</p>}{query.isLoading && <p>正在读取登记和状态…</p>}
    {query.data?.groups.filter(g => g.error || g.truncated).map(g => <p className="error" key={g.repositoryGroupId}>{g.name}：{g.error || "登记清单超过限制，统计仅包含已登记项"}</p>)}
    <div className={`worktree-layout ${worktree ? "with-detail" : ""}`}><div className="worktree-collections">{collections.filter(c => c.bases.some(base => base.worktrees.some(w => visibleIds.has(w.worktreeId)))).map(collection => {
      const members = collection.bases.flatMap(base => base.worktrees);
      const extraAddresses = new Set(collection.bases.flatMap(base => base.remote?.remotes.flatMap(r => [...r.fetchUrls, ...r.pushUrls]) ?? []).filter(url => url !== collection.url));
      return <section className="git-address-group" key={collection.key} aria-label={`Git 地址：${collection.url ?? collection.bases[0].name}`}><header className="git-address-header"><div><span className="git-address-label">Git 地址</span><code>{collection.url ?? (collection.bases[0].remote?.error ? "地址读取失败" : "未配置远程 · 本地仓库")}</code></div><small>{collection.bases.length} 个 base · {members.length} 个 worktree · 修改 {members.filter(w => stateRank(w) === 0).length} / 干净 {members.filter(w => stateRank(w) === 1).length} / 未知 {members.filter(w => stateRank(w) === 2).length}</small></header>
        {extraAddresses.size > 0 && <details className="git-extra-addresses"><summary>其他 Git 地址 · {extraAddresses.size} 个</summary>{collection.bases.map(base => <div key={base.repositoryGroupId}>{collection.bases.length > 1 && <strong>{base.name}</strong>}<RemoteAddresses remote={base.remote}/></div>)}</details>}
        {collection.bases.filter(base => base.worktrees.some(w => visibleIds.has(w.worktreeId))).map(base => <section className="worktree-base" aria-label={`本地 base：${base.name}`} data-base={base.repositoryGroupId} key={base.repositoryGroupId}><div className="worktree-base-header"><strong>Base · {base.name}</strong><code title={base.commonDir}>{base.commonDir}</code><span>{base.worktrees.length} 个 worktree</span></div>{base.remote?.error && <p className="error">{base.remote.error}</p>}<div className="worktree-table" role="table" aria-label={`${base.name} Worktree 列表`}><div className="worktree-table-head" role="row"><span role="columnheader">目录 / 共享仓库</span><span role="columnheader">分支</span><span role="columnheader">文件状态</span><span role="columnheader">未发布提交</span><span/></div>{base.worktrees.filter(w => visibleIds.has(w.worktreeId)).sort((a, b) => stateRank(a) - stateRank(b) || a.path.localeCompare(b.path)).map(w => <WorktreeRow key={w.worktreeId} worktree={w} selected={selected === w.worktreeId} onSelect={() => setSelected(selected === w.worktreeId ? undefined : w.worktreeId)}/>)}</div></section>)}
      </section>;
    })}{query.data && visible.length === 0 && <p className="panel-empty">当前筛选下没有 worktree。</p>}</div>
      {worktree && selection && <aside className="worktree-detail" aria-label="Worktree 详情"><div className="worktree-detail-title"><div><small>{selection.group.name}</small><h3>{worktree.branch ?? "detached HEAD"}</h3></div><button aria-label="关闭 Worktree 详情" title="关闭（Esc）" onClick={() => setSelected(undefined)}><X size={17}/></button></div><code>{worktree.path}</code><p>{worktree.main === true ? "主工作区" : worktree.main === false ? "关联 worktree" : "主身份未知"}{worktree.current && " · 当前选中"}{!worktree.inWorkspace && " · 工作区外（只读）"}</p><p>{stateText(worktree)}</p><small>HEAD {worktree.head?.slice(0, 8) ?? "无"} · {new Date(worktree.readAt).toLocaleTimeString()}</small><dl><dt>Git 远程地址</dt><dd><RemoteAddresses remote={selection.group.remote}/></dd><dt>本地 base（共享仓库）</dt><dd><code>{selection.group.commonDir}</code></dd><dt>Upstream</dt><dd>{worktree.upstream ? `${worktree.upstream.ref} · ahead ${worktree.upstream.ahead} / behind ${worktree.upstream.behind}` : "无 upstream / 未知"}</dd><dt>未被远程引用包含</dt><dd>{worktree.unpublished === null ? "未知" : `${worktree.unpublished} 个提交`}</dd><dt>默认分支关系</dt><dd>{worktree.defaultBranch ?? "默认分支未知"} · {({ equal: "相同", ancestor: "祖先", descendant: "后代", diverged: "已分叉", unknown: "未知" })[worktree.defaultRelation]}</dd></dl><small>{worktree.syncNote}</small><SyncControl repositoryGroupId={worktree.repositoryGroupId}/><div className="git-actions"><button onClick={() => onNavigate(worktree, "history")}>定位提交图</button>{worktree.repositoryId && <button onClick={() => onNavigate(worktree, "changes")}>查看独立修改</button>}<button disabled={busy} onClick={inspect}>{busy ? "检查中…" : "清理预览"}</button></div>
        {error && <p className="error">{error}</p>}{preview?.worktree.worktreeId === worktree.worktreeId && <section className="removal-preview"><h3>清理预览</h3><p>{preview.allowed ? "符合关联 worktree 清理条件" : "当前不可移除"}</p><p>保留分支：{preview.branchPreserved ?? "detached；由已有引用保留提交"}</p><p>忽略内容：{preview.ignoredCount ?? "未知"} · 未保存：{preview.unsavedCount} · 其他会话：{preview.otherSessionCount}</p>{preview.reasons.map(r => <p className="error" key={r}>{r}</p>)}{preview.warnings.map(w => <p className="boundary-note" key={w}>{w}</p>)}<small>只读清理预览</small></section>}
      </aside>}</div></div>;
}
type WorktreeBase = WorktreeOverview["groups"][number];
function groupByGitAddress(groups: WorktreeBase[]) {
  const result = new Map<string, { key: string; url: string | null; bases: WorktreeBase[] }>();
  const baseRank = (base: WorktreeBase) => Math.min(2, ...base.worktrees.map(stateRank));
  for (const base of groups) {
    const url = base.remote?.primaryUrl ?? null;
    // This only groups the display. common-dir identities and operation scopes remain independent.
    const key = url && !base.remote.error ? `remote:${url}` : `base:${base.repositoryGroupId}`;
    const collection = result.get(key) ?? { key, url, bases: [] };
    collection.bases.push(base); result.set(key, collection);
  }
  return [...result.values()].map(collection => ({ ...collection, bases: [...collection.bases].sort((a, b) => baseRank(a) - baseRank(b) || a.name.localeCompare(b.name)) }))
    .sort((a, b) => Math.min(...a.bases.map(baseRank)) - Math.min(...b.bases.map(baseRank)) || (a.url ?? a.bases[0].name).localeCompare(b.url ?? b.bases[0].name));
}

function RemoteAddresses({ remote }: { remote?: GitRemoteAddresses }) {
  if (remote?.error) return <p className="error">{remote.error}</p>;
  if (!remote?.remotes.length) return <small>未配置远程，按本地 base 展示。</small>;
  return <div className="git-remote-addresses">{remote.remotes.map(r => <div key={r.name}>{r.fetchUrls.map(url => <div key={`fetch:${url}`}><span>{r.name} · fetch</span><code>{url}</code></div>)}{r.pushUrls.filter(url => !r.fetchUrls.includes(url)).map(url => <div key={`push:${url}`}><span>{r.name} · push</span><code>{url}</code></div>)}</div>)}</div>;
}

function WorktreeRow({ worktree: w, selected, onSelect }: { worktree: WorktreeStatus; selected: boolean; onSelect(): void }) {
  return <button role="row" aria-label={`${w.workspacePath ?? w.path} · ${stateText(w)}`} aria-expanded={selected} data-worktree={w.worktreeId} data-state={['dirty', 'clean', 'unknown'][stateRank(w)]} className={`worktree-row ${selected ? "selected" : ""}`} onClick={onSelect}>
    <span role="cell" className="worktree-directory"><span className="worktree-name"><strong title={w.path}>{w.workspacePath || w.path.split("/").at(-1)}</strong>{w.main === true && <span className="worktree-badge main">主工作区</span>}{w.current && <span className="worktree-badge current">当前</span>}{w.main === null && <span className="worktree-badge">主身份未知</span>}</span><small title={w.path}>{w.path}</small></span>
    <span role="cell" className="worktree-branch" title={w.branch ?? "detached HEAD"}><GitBranch size={13}/><span>{w.branch ?? (w.bare ? "裸仓库" : "detached HEAD")}</span></span>
    <span role="cell" className={`worktree-file-state ${['dirty', 'clean', 'unknown'][stateRank(w)]}`}><strong>{!w.status ? "未知" : w.status.clean ? "干净" : `修改 ${w.status.files.length}`}</strong><small>{w.locked !== undefined ? "已锁定" : w.prunable !== undefined ? "登记失效" : !w.inWorkspace ? "工作区外 · 只读" : !w.status ? w.error : w.status.clean ? "无文件改动" : `暂存 ${w.status.counts.staged} · 未暂存 ${w.status.counts.unstaged} · 未跟踪 ${w.status.counts.untracked} · 冲突 ${w.status.counts.conflicted}`}</small></span>
    <span role="cell" className="worktree-unpublished" title="基于已获取的全部远程引用">{w.unpublished ?? "未知"}</span><ChevronRight size={15}/>
  </button>;
}
function stateRank(w: WorktreeStatus) { return !w.status ? 2 : w.status.clean ? 1 : 0; }
function stateText(w: WorktreeStatus) { return !w.status ? `状态未知：${w.error ?? "尚未读取"}` : w.status.clean ? "文件干净" : `有修改 ${w.status.files.length} · 暂存 ${w.status.counts.staged} / 未暂存 ${w.status.counts.unstaged} / 未跟踪 ${w.status.counts.untracked} / 冲突 ${w.status.counts.conflicted}`; }
