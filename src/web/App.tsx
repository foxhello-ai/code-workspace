import { useEffect, useMemo, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronRight, ChevronsRight, Clock3, File, Folder, FolderOpen, GitBranch, History, RefreshCw, Save, X, Files, GitCompare, Layers2, Plus, Trash2, XCircle } from "lucide-react";
import type { DiffDocument, FileTreeEntry, GitChangedFile, GitCommitDetail, GitCommitSummary } from "../shared/contracts";
import { api, ApiClientError } from "./api";
import { type TextTab, useAppStore } from "./store";

type View = "files" | "changes" | "history";
const RECENT_WORKSPACES_KEY = "code-workspace.recent-workspaces";

function message(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
function loadRecentWorkspaces() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  } catch { return []; }
}

export function App() {
  const store = useAppStore();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("files");
  const [workspacePath, setWorkspacePath] = useState("");
  const [notice, setNotice] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const active = store.tabs.find((tab) => tab.id === store.activeId) ?? null;

  useEffect(() => { api.workspace().then((workspace) => { store.setWorkspace(workspace); rememberWorkspace(workspace.rootPath); }).catch(() => undefined); }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (store.tabs.some((t) => t.type === "text" && t.dirty)) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [store.tabs]);
  useEffect(() => {
    if (!store.workspace) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/events?workspaceId=${store.workspace.id}`);
    ws.onmessage = async ({ data }) => {
      const envelope = JSON.parse(data);
      const event = envelope.event;
      if (!event) { if (envelope.type === "workspace.resyncRequired") { queryClient.invalidateQueries(); store.markDiffsStale(); } return; }
      if (event.type.startsWith("file.") && event.path) {
        queryClient.invalidateQueries({ queryKey: ["tree"] });
        const tab = store.tabs.find((t) => (t.type === "text" || t.type === "image") && t.path === event.path);
        if (tab) {
          if (event.type === "file.deleted") tab.type === "image" ? store.refreshImage(event.path, null) : store.external(event.path, null);
          else api.file(event.path).then((file) => tab.type === "image" ? store.refreshImage(event.path!, file) : store.external(event.path!, file)).catch(() => undefined);
        }
      }
      if (event.type.startsWith("directory.")) queryClient.invalidateQueries({ queryKey: ["tree"] });
      if (event.type.startsWith("git.")) { queryClient.invalidateQueries({ queryKey: ["git"] }); store.markDiffsStale(); }
    };
    return () => ws.close();
  }, [store.workspace?.id]);
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const activeId = useAppStore.getState().activeId;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "w" && activeId) {
        event.preventDefault();
        useAppStore.getState().closeTab(activeId);
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "o" && activeId) {
        event.preventDefault();
        useAppStore.getState().closeOtherTabs(activeId);
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "r" && activeId) {
        event.preventDefault();
        useAppStore.getState().closeTabsToRight(activeId);
      } else if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        useAppStore.getState().closeAllTabs();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  function rememberWorkspace(path: string) {
    setRecentWorkspaces((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 10);
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
      return next;
    });
  }
  function removeRecentWorkspace(path: string) {
    setRecentWorkspaces((current) => {
      const next = current.filter((item) => item !== path);
      localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
      return next;
    });
  }
  async function openWorkspace(pathOverride?: string) {
    const target = (pathOverride ?? workspacePath).trim();
    if (!target) return setNotice("请输入工作区路径");
    setSwitchingWorkspace(true);
    try { const ws = await api.openWorkspace(target); store.clear(); store.setWorkspace(ws); queryClient.clear(); setWorkspacePath(ws.rootPath); rememberWorkspace(ws.rootPath); setNotice(""); setView("files"); }
    catch (error) { setNotice(message(error)); }
    finally { setSwitchingWorkspace(false); }
  }
  async function switchWorkspace() {
    if (store.tabs.some((tab) => tab.type === "text" && tab.dirty) && !confirm("存在未保存文件，确定切换工作区吗？")) return;
    setSwitchingWorkspace(true);
    setNotice("正在关闭当前工作区…");
    try {
      await api.closeWorkspace();
      store.clear();
      queryClient.clear();
      setWorkspacePath("");
      setNotice("");
    } catch (error) { setNotice(`关闭工作区失败：${message(error)}`); }
    finally { setSwitchingWorkspace(false); }
  }
  async function save(tab: TextTab, version = tab.diskVersion) {
    try { const file = await api.save(tab.path, tab.bufferText, version); store.saved(tab.id, file); setNotice("已保存"); }
    catch (error) {
      if (error instanceof ApiClientError && error.code === "FILE_VERSION_CONFLICT") {
        const disk = await api.file(tab.path); store.external(tab.path, disk); setNotice("磁盘内容已变化，请处理冲突");
      } else setNotice(message(error));
    }
  }

  if (!store.workspace) return <OpenWorkspace path={workspacePath} setPath={setWorkspacePath} open={openWorkspace} error={notice} recent={recentWorkspaces} removeRecent={removeRecentWorkspace} busy={switchingWorkspace} />;
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">Code Workspace</div><div className="workspace-name">{store.workspace.name}</div>
      {store.workspace.git && <div className="branch"><GitBranch size={14}/>{store.workspace.git.branch ?? "detached"}</div>}
      <button className="icon-button" title="刷新" onClick={() => queryClient.invalidateQueries()}><RefreshCw size={16}/></button>
      <button className="close-workspace" disabled={switchingWorkspace} onClick={switchWorkspace}>{switchingWorkspace ? "正在切换…" : "切换工作区"}</button>
    </header>
    <aside className="activitybar">
      <NavButton active={view === "files"} title="文件" onClick={() => setView("files")}><Files/></NavButton>
      <NavButton active={view === "changes"} title="Git 修改" onClick={() => setView("changes")}><GitCompare/></NavButton>
      <NavButton active={view === "history"} title="Git 历史" onClick={() => setView("history")}><History/></NavButton>
    </aside>
    <aside className="sidebar">
      {view === "files" && <Explorer
        onOpen={async (path) => { try { const file = await api.file(path); if (file.binary && isPreviewableImage(path)) store.openImage(file); else if (file.binary) setNotice("该二进制文件暂不支持预览"); else if (file.content === null) setNotice("文件过大或编码不受支持，已阻止编辑"); else store.openFile(file); } catch (e) { setNotice(message(e)); } }}
        onNotice={setNotice}
      />}
      {view === "changes" && <Changes onDiff={(scope, path) => openDiff(api.diff(scope, path), `${scope}: ${path}`)} />}
      {view === "history" && <HistoryPanel onDiff={(hash, path) => openDiff(api.commitDiff(hash, path), `${hash.slice(0, 7)}: ${path ?? "全部修改"}`)} />}
    </aside>
    <main className="editor-area">
      <div className="tab-strip">
        <div className="tabs">{store.tabs.map((tab) => <div key={tab.id} className={`tab ${tab.id === store.activeId ? "active" : ""}`} onClick={() => store.activate(tab.id)}>
          <span>{tab.type === "diff" || tab.type === "imageDiff" ? tab.title : tab.path.split("/").at(-1)}</span>{tab.type === "text" && tab.dirty && <i>●</i>}{(tab.type === "text" || tab.type === "image") && tab.externalState !== "current" && <b>!</b>}{(tab.type === "diff" || tab.type === "imageDiff") && tab.stale && <b>!</b>}<button title="关闭当前 (Ctrl/Cmd+W)" onClick={(e) => { e.stopPropagation(); store.closeTab(tab.id); }}><X size={13}/></button>
        </div>)}</div>
        <div className="tab-actions">
          <button disabled={!store.activeId || store.tabs.length < 2} title="关闭其他 (Alt+Shift+O)" onClick={() => store.activeId && store.closeOtherTabs(store.activeId)}><Layers2/></button>
          <button disabled={!store.activeId || store.tabs.findIndex((tab) => tab.id === store.activeId) === store.tabs.length - 1} title="关闭右侧 (Alt+Shift+R)" onClick={() => store.activeId && store.closeTabsToRight(store.activeId)}><ChevronsRight/></button>
          <button disabled={!store.tabs.length} title="关闭全部 (Alt+Shift+A)" onClick={() => store.closeAllTabs()}><XCircle/></button>
        </div>
      </div>
      {!active && <div className="empty"><Files size={52}/><h2>选择文件开始编辑</h2><p>外部程序的文件修改会自动同步到这里。</p></div>}
      {active?.type === "text" && <>
        {active.externalState !== "current" && (
          <ConflictBar tab={active} save={save}/>
        )}
        <div className="editor-toolbar"><span>{active.path}</span><button disabled={!active.dirty || active.externalState !== "current"} onClick={() => save(active)}><Save size={15}/>保存</button></div>
        {active.externalState === "changed" && active.diskText !== undefined ? <DiffEditor height="100%" theme="vs-dark" original={active.diskText} modified={active.bufferText} language={active.language} options={{ originalEditable: false, automaticLayout: true }}/>
          : <Editor
              height="100%"
              theme="vs-dark"
              path={`workspace:///${active.path}`}
              language={active.language}
              value={active.bufferText}
              onChange={(value) => store.edit(active.id, value ?? "")}
              options={{ automaticLayout: true, minimap: { enabled: false }, fontSize: 14, wordWrap: "off" }}
              onMount={(_, monaco) => monaco.editor.addKeybindingRules([])}
            />}
      </>}
      {active?.type === "diff" && <><div className={`editor-toolbar ${active.stale ? "stale" : ""}`}><span>{active.title}</span>{active.stale && <span>Git 状态已变化，请重新打开此 Diff</span>}</div><DiffEditor height="100%" theme="vs-dark" original={active.oldText} modified={active.newText} language={active.language} options={{ readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: window.innerWidth > 800 }}/></>}
      {active?.type === "imageDiff" && <><div className={`editor-toolbar ${active.stale ? "stale" : ""}`}><span>{active.title}</span>{active.stale && <span>Git 状态已变化，请重新打开此 Diff</span>}</div><div className="image-diff"><ImageDiffSide label={active.oldLabel} url={active.oldUrl}/><ImageDiffSide label={active.newLabel} url={active.newUrl}/></div></>}
      {active?.type === "image" && <><div className="editor-toolbar"><span>{active.path}</span><span>图片预览</span></div><div className="image-preview">{active.externalState === "deleted" ? <div className="image-missing">图片已从磁盘删除</div> : <img src={`/api/files/raw?path=${encodeURIComponent(active.path)}&v=${encodeURIComponent(active.version)}`} alt={active.path}/>}</div></>}
    </main>
    <footer className="statusbar"><span>{notice || "就绪"}</span><span>{active?.type === "text" ? `${active.dirty ? "未保存" : "已保存"} · ${active.externalState}` : ""}</span></footer>
  </div>;

  async function openDiff(promise: Promise<DiffDocument>, title: string) {
    try {
      const diff = await promise;
      if (!diff.files.length) return setNotice("没有可显示的修改");
      const file = diff.files[0];
      if (file.binary) {
        if (!isPreviewableImage(file.path)) return setNotice("该二进制文件暂不支持 Diff 预览");
        const oldPath = file.oldPath ?? file.path;
        const oldUrl = file.status === "added" ? undefined : diff.scope === "working" ? gitImageUrl("index", oldPath) : diff.scope === "staged" || diff.scope === "all" ? gitImageUrl("head", oldPath) : gitImageUrl("commit", oldPath, diff.base);
        const newUrl = file.status === "deleted" ? undefined : diff.scope === "staged" ? gitImageUrl("index", file.path) : diff.scope === "working" || diff.scope === "all" ? gitImageUrl("worktree", file.path) : gitImageUrl("commit", file.path, diff.target);
        store.openImageDiff({ id: `image-diff:${diff.id}:${file.path}`, type: "imageDiff", title, oldUrl, newUrl, oldLabel: diff.base, newLabel: diff.target });
        return;
      }
      if (file.truncated) return setNotice("Diff 内容超过显示限制");
      store.openDiff({ id: `diff:${diff.id}:${file.path}`, type: "diff", title, oldText: file.oldText ?? "", newText: file.newText ?? "", language: languageFor(file.path) });
    } catch (error) { setNotice(message(error)); }
  }
}

function OpenWorkspace({ path, setPath, open, error, recent, removeRecent, busy }: { path: string; setPath(v: string): void; open(path?: string): void; error: string; recent: string[]; removeRecent(path: string): void; busy: boolean }) {
  return <div className="open-page"><div className="open-card"><div className="logo"><Files/></div><h1>Code Workspace</h1><p>打开一个本地目录，浏览、编辑并检查 Git 修改。</p><label>工作区绝对路径</label><div className="open-input-row"><input autoFocus value={path} disabled={busy} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open()} placeholder="/home/user/project"/><button className="primary" disabled={busy} onClick={() => open()}>{busy ? "正在打开…" : "打开工作区"}</button></div>{error && <div className="error">{error}</div>}{recent.length > 0 && <section className="recent-workspaces"><h2><Clock3/>最近打开</h2>{recent.map((item) => <div className="recent-workspace" key={item}><button className="recent-open" disabled={busy} onClick={() => open(item)}><FolderOpen/><span><strong>{item.split("/").filter(Boolean).at(-1) ?? item}</strong><small>{item}</small></span><ArrowRight/></button><button className="recent-remove" title="从最近列表移除" onClick={() => removeRecent(item)}><X/></button></div>)}</section>}<small>最近路径只保存在当前浏览器。服务不会启动终端或管理任何外部工具会话。</small></div></div>;
}

function NavButton({ active, title, onClick, children }: { active: boolean; title: string; onClick(): void; children: React.ReactNode }) { return <button className={active ? "active" : ""} title={title} onClick={onClick}>{children}</button>; }

function Explorer({ onOpen, onNotice }: { onOpen(path: string): void; onNotice(text: string): void }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  async function create(kind: "file" | "directory") { const target = prompt(`输入新${kind === "file" ? "文件" : "文件夹"}的相对路径`); if (!target) return; try { kind === "file" ? await api.createFile(target) : await api.createDirectory(target); queryClient.invalidateQueries({ queryKey: ["tree"] }); } catch (e) { onNotice(message(e)); } }
  return <><PanelTitle title="文件"><button title="新建文件" onClick={() => create("file")}><Plus size={14}/></button><button title="新建文件夹" onClick={() => create("directory")}><Folder size={14}/></button></PanelTitle><Tree path="" expanded={expanded} setExpanded={setExpanded} onOpen={onOpen} onNotice={onNotice}/></>;
}

function Tree({ path, expanded, setExpanded, onOpen, onNotice }: { path: string; expanded: Set<string>; setExpanded(v: Set<string>): void; onOpen(path: string): void; onNotice(text: string): void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["tree", path], queryFn: () => api.tree(path), enabled: expanded.has(path) });
  if (query.isLoading) return <div className="tree-loading">加载中…</div>;
  return <div className="tree">{query.data?.map((entry) => <div key={entry.path}>
    <div className="tree-row" title={entry.path} onDoubleClick={async () => {
      const next = prompt("重命名为", entry.path); if (!next || next === entry.path) return; try { await api.rename(entry.path, next); queryClient.invalidateQueries({ queryKey: ["tree"] }); } catch (e) { onNotice(message(e)); }
    }}>
      {entry.kind === "directory" ? <button onClick={() => { const next = new Set(expanded); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); setExpanded(next); }}>{expanded.has(entry.path) ? <ChevronDown/> : <ChevronRight/>}</button> : <span className="indent"/>}
      <span className="entry" onClick={() => entry.kind === "directory" ? undefined : onOpen(entry.path)}>{entry.kind === "directory" ? expanded.has(entry.path) ? <FolderOpen/> : <Folder/> : <File/>}<span>{entry.name}</span>{entry.gitState && <em className={`git-${entry.gitState}`}>{stateLetter(entry.gitState)}</em>}</span>
      <button className="row-action" title="删除" onClick={async () => { if (!confirm(`确定删除 ${entry.path}？`)) return; try { await api.remove(entry.path, entry.kind === "directory"); queryClient.invalidateQueries({ queryKey: ["tree"] }); } catch (e) { onNotice(message(e)); } }}><Trash2/></button>
    </div>
    {entry.kind === "directory" && expanded.has(entry.path) && <div className="nested"><Tree path={entry.path} expanded={expanded} setExpanded={setExpanded} onOpen={onOpen} onNotice={onNotice}/></div>}
  </div>)}</div>;
}

function Changes({ onDiff }: { onDiff(scope: "working" | "staged" | "all", path: string): void }) {
  const query = useQuery({ queryKey: ["git", "status"], queryFn: api.gitStatus, retry: false });
  if (query.isError) return <PanelError text={message(query.error)}/>;
  const groups: Array<[string, "conflicted" | "staged" | "unstaged" | "untracked", "working" | "staged"]> = [["冲突", "conflicted", "working"], ["已暂存", "staged", "staged"], ["未暂存", "unstaged", "working"], ["未跟踪", "untracked", "working"]];
  return <><PanelTitle title="Git 修改"><button title="刷新" onClick={() => query.refetch()}><RefreshCw size={14}/></button></PanelTitle><button className="wide-action" onClick={() => query.data?.files[0] && onDiff("all", query.data.files[0].path)}>查看全部修改</button>{groups.map(([title, category, scope]) => { const files = query.data?.files.filter((f) => f.categories.includes(category)) ?? []; return files.length ? <section className="change-group" key={category}><h4>{title}<span>{files.length}</span></h4>{files.map((file) => <ChangeRow key={`${category}:${file.path}`} file={file} onClick={() => onDiff(scope, file.path)}/>)}</section> : null; })}{query.data?.clean && <div className="panel-empty">工作区没有修改</div>}</>;
}

function ChangeRow({ file, onClick }: { file: GitChangedFile; onClick(): void }) { return <button className="change-row" onClick={onClick}><span>{file.path.split("/").at(-1)}</span><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}{file.additions !== undefined && ` · +${file.additions} -${file.deletions ?? 0}`}</small><em>{file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus}</em></button>; }

function HistoryPanel({ onDiff }: { onDiff(hash: string, path?: string): void }) {
  const [commits, setCommits] = useState<GitCommitSummary[]>([]); const [cursor, setCursor] = useState<string | null | undefined>(); const [selected, setSelected] = useState<string>();
  const page = useQuery({ queryKey: ["git", "history", cursor ?? "first"], queryFn: () => api.history(cursor ?? undefined), retry: false });
  useEffect(() => { if (page.data) setCommits((current) => cursor ? [...current, ...page.data.items.filter((x) => !current.some((y) => y.hash === x.hash))] : page.data.items); }, [page.data]);
  const detail = useQuery({ queryKey: ["git", "commit", selected], queryFn: () => api.commit(selected!), enabled: Boolean(selected) });
  if (page.isError) return <PanelError text={message(page.error)}/>;
  return <><PanelTitle title="Git 历史"/>{selected && detail.data ? <CommitDetails detail={detail.data} back={() => setSelected(undefined)} diff={onDiff}/> : <div className="history-list">{commits.map((commit) => <button key={commit.hash} onClick={() => setSelected(commit.hash)}><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code>{commit.authorName}</span><time>{new Date(commit.committedAt).toLocaleString()}</time>{commit.parents.length > 1 && <em>merge</em>}</button>)}{page.data?.nextCursor && <button className="load-more" onClick={() => setCursor(page.data!.nextCursor)}>加载更多</button>}</div>}</>;
}

function CommitDetails({ detail, back, diff }: { detail: GitCommitDetail; back(): void; diff(hash: string, path?: string): void }) { return <div className="commit-detail"><button className="back" onClick={back}>← 返回历史</button><h3>{detail.subject}</h3><code>{detail.hash}</code><p>{detail.body}</p><div className="commit-meta">{detail.authorName} · {new Date(detail.committedAt).toLocaleString()} · +{detail.additions} -{detail.deletions}</div>{detail.files.map((file) => <button className="commit-file" key={`${file.status}:${file.path}`} onClick={() => diff(detail.hash, file.path)}><em>{file.status[0]}</em><span>{file.path}</span></button>)}</div>; }

function ConflictBar({ tab, save }: { tab: TextTab; save(tab: TextTab, version?: string): void }) {
  const store = useAppStore();
  return <div className="conflict-bar"><strong>{tab.externalState === "deleted" ? "文件已从磁盘删除" : "磁盘内容已发生变化，左侧为磁盘，右侧为编辑器"}</strong>{tab.externalState === "changed" && <><button onClick={() => { if (!confirm("使用磁盘版本并放弃编辑器修改？")) return; store.saved(tab.id, { path: tab.path, content: tab.diskText ?? "", version: tab.diskNewVersion!, encoding: "utf-8", lineEnding: "LF", size: 0, readOnly: false, binary: false, finalNewline: false }); }}>使用磁盘版本</button><button onClick={() => { if (confirm("确认用编辑器内容覆盖当前磁盘版本？")) save(tab, tab.diskNewVersion); }}>保留编辑器版本</button></>}</div>;
}

function PanelTitle({ title, children }: { title: string; children?: React.ReactNode }) { return <div className="panel-title"><strong>{title}</strong><span>{children}</span></div>; }
function PanelError({ text }: { text: string }) { return <div className="panel-empty error">{text}</div>; }
function languageFor(path: string) { const ext = path.split(".").at(-1); return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", py: "python", yml: "yaml", yaml: "yaml" } as Record<string, string>)[ext ?? ""] ?? "plaintext"; }
function stateLetter(state: string) { return ({ modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" } as Record<string, string>)[state] ?? ""; }
function isPreviewableImage(path: string) { return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path); }
function gitImageUrl(source: "worktree" | "index" | "head" | "commit", path: string, hash?: string) { return `/api/git/image?source=${source}&path=${encodeURIComponent(path)}${hash ? `&hash=${encodeURIComponent(hash)}` : ""}`; }
function ImageDiffSide({ label, url }: { label: string; url?: string }) { return <section><header>{label}</header><div>{url ? <img src={url} alt={label}/> : <span>此版本中不存在图片</span>}</div></section>; }
