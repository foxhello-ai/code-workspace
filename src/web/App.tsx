import { useEffect, useMemo, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronRight, ChevronsRight, Clock3, Copy, ExternalLink, File, Folder, FolderOpen, GitBranch, GitFork, History, List, LockKeyhole, LogOut, RefreshCw, Save, Search, X, Files, GitCompare, Layers2, Plus, Trash2, XCircle } from "lucide-react";
import type { DiffDocument, FileTreeEntry, GitBranchInfo, GitChangedFile, GitCommitDetail, GitCommitSummary, GitGraphCommit, GitRepositoryInfo } from "../shared/contracts";
import { api, ApiClientError, apiSessionId } from "./api";
import { type TextTab, useAppStore } from "./store";

type View = "files" | "changes" | "history";
const RECENT_WORKSPACES_KEY = "code-workspace.recent-workspaces";
const SIDEBAR_WIDTH_KEY = "code-workspace.sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 290;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 520;

function message(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }
function loadRecentWorkspaces() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
  } catch { return []; }
}
function loadSidebarWidth() {
  const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? DEFAULT_SIDEBAR_WIDTH);
  return Number.isFinite(value) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)) : DEFAULT_SIDEBAR_WIDTH;
}

export function App() {
  const store = useAppStore();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("files");
  const [workspacePath, setWorkspacePath] = useState("");
  const [notice, setNotice] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const active = store.tabs.find((tab) => tab.id === store.activeId) ?? null;
  const currentRepository = store.workspace?.git ?? null;

  useEffect(() => {
    api.authStatus().then(({ authenticated }) => {
      setAuthenticated(authenticated);
      if (authenticated) api.workspace().then((workspace) => { store.setWorkspace(workspace); rememberWorkspace(workspace.rootPath); }).catch(() => undefined);
    }).catch(() => setAuthenticated(false));
    const requireAuth = () => { store.clear(); queryClient.clear(); setAuthenticated(false); };
    window.addEventListener("code-workspace:auth-required", requireAuth);
    return () => window.removeEventListener("code-workspace:auth-required", requireAuth);
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (store.tabs.some((t) => t.type === "text" && t.dirty)) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [store.tabs]);
  useEffect(() => {
    const timers = store.tabs.filter((tab): tab is TextTab => tab.type === "text" && tab.dirty && tab.externalState === "current" && tab.saveState === "pending").map((tab) => setTimeout(() => save(tab, tab.diskVersion, true), 1000));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [store.tabs]);
  useEffect(() => {
    if (!store.workspace) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/api/events?workspaceId=${store.workspace.id}&sessionId=${encodeURIComponent(apiSessionId())}`);
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
  async function switchBranch(branch: GitBranchInfo) {
    if (store.tabs.some((tab) => tab.type === "text" && tab.dirty) && !confirm("存在未保存文件。切换分支可能改变磁盘内容，确定继续吗？")) return;
    setNotice(`正在切换到 ${branch.name}…`);
    try {
      let result;
      try { result = await api.switchBranch(branch.name, branch.kind, false, currentRepository?.id); }
      catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== "GIT_WORKTREE_DIRTY" || !confirm("Git 工作区存在未提交修改。是否尝试保留这些修改并切换分支？")) throw error;
        result = await api.switchBranch(branch.name, branch.kind, true, currentRepository?.id);
      }
      store.setWorkspace(result.workspace);
      store.markDiffsStale();
      await queryClient.invalidateQueries();
      setNotice(`已切换到 ${result.workspace.git?.branch ?? branch.name}`);
    } catch (error) { setNotice(`分支切换失败：${message(error)}`); }
  }
  async function selectRepository(repository: GitRepositoryInfo) {
    try {
      const workspace = await api.selectRepository(repository.id);
      store.setWorkspace(workspace);
      store.markDiffsStale();
      await queryClient.invalidateQueries({ queryKey: ["git"] });
      setNotice(`当前 Git 项目：${repository.workspacePath || repository.name}`);
    } catch (error) { setNotice(`切换 Git 项目失败：${message(error)}`); }
  }
  async function save(tab: TextTab, version = tab.diskVersion, automatic = false) {
    const latest = useAppStore.getState().tabs.find((item): item is TextTab => item.id === tab.id && item.type === "text");
    if (!latest || !latest.dirty || latest.externalState !== "current") return;
    store.saving(latest.id);
    try { const file = await api.save(latest.path, latest.bufferText, version); store.saved(latest.id, file); setNotice(automatic ? "已自动保存" : "已保存"); }
    catch (error) {
      if (error instanceof ApiClientError && error.code === "FILE_VERSION_CONFLICT") {
        const disk = await api.file(latest.path); store.external(latest.path, disk); store.saveFailed(latest.id, "磁盘内容已变化"); setNotice("磁盘内容已变化，请处理冲突");
      } else { const text = message(error); store.saveFailed(latest.id, text); setNotice(text); }
    }
  }

  if (authenticated === null) return <div className="auth-loading"><LockKeyhole/><span>正在验证登录状态…</span></div>;
  if (!authenticated) return <LoginPage onLogin={() => { setAuthenticated(true); setNotice(""); }} />;
  if (!store.workspace) return <OpenWorkspace path={workspacePath} setPath={setWorkspacePath} open={openWorkspace} error={notice} recent={recentWorkspaces} removeRecent={removeRecentWorkspace} busy={switchingWorkspace} logout={async () => { await api.logout(); setAuthenticated(false); }} />;
  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 800) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let currentWidth = startWidth;
    document.body.classList.add("resizing-sidebar");
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + moveEvent.clientX - startX));
      currentWidth = width;
      setSidebarWidth(width);
    };
    const up = () => {
      document.body.classList.remove("resizing-sidebar");
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentWidth));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function resetSidebarWidth() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
  }

  return <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <header className="topbar">
      <div className="brand">Code Workspace</div><div className="workspace-name">{store.workspace.name}</div>
      {store.workspace.repositories.length > 0 && (
        <RepositoryPicker repositories={store.workspace.repositories} current={currentRepository} onSelect={selectRepository}/>
      )}
      {currentRepository && (
        <BranchPicker current={currentRepository.branch} repositoryId={currentRepository.id} onSwitch={switchBranch}/>
      )}
      <button className="icon-button" title="刷新" onClick={() => queryClient.invalidateQueries()}><RefreshCw size={16}/></button>
      <button className="close-workspace" disabled={switchingWorkspace} onClick={switchWorkspace}>{switchingWorkspace ? "正在切换…" : "切换工作区"}</button>
      <button className="logout-button" title="退出登录" onClick={async () => { await api.logout(); store.clear(); queryClient.clear(); setAuthenticated(false); }}><LogOut size={15}/></button>
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
      {view === "changes" && <Changes repository={currentRepository} onDiff={(scope, path) => openDiff(api.diff(scope, path, currentRepository?.id), `${repoLabel(currentRepository)} · ${scope}: ${path}`, currentRepository?.id)} />}
      {view === "history" && <HistoryPanel repository={currentRepository} onDiff={(hash, path) => openDiff(api.commitDiff(hash, path, currentRepository?.id), `${repoLabel(currentRepository)} · ${hash.slice(0, 7)}: ${path ?? "全部修改"}`, currentRepository?.id)} />}
    </aside>
    <div className="sidebar-resizer" title="拖拽调整侧栏宽度，双击恢复默认" onPointerDown={startSidebarResize} onDoubleClick={resetSidebarWidth}/>
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
        <div className="editor-toolbar"><span>{active.path}</span><span>{saveStateText(active)}</span><button disabled={!active.dirty || active.externalState !== "current" || active.saveState === "saving"} onClick={() => save(active)}><Save size={15}/>保存</button></div>
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

  async function openDiff(promise: Promise<DiffDocument>, title: string, repositoryId?: string) {
    try {
      const diff = await promise;
      if (!diff.files.length) return setNotice("没有可显示的修改");
      const file = diff.files[0];
      if (file.binary) {
        if (!isPreviewableImage(file.path)) return setNotice("该二进制文件暂不支持 Diff 预览");
        const oldPath = file.oldPath ?? file.path;
        const oldUrl = file.status === "added" ? undefined : diff.scope === "working" ? gitImageUrl("index", oldPath, undefined, repositoryId) : diff.scope === "staged" || diff.scope === "all" ? gitImageUrl("head", oldPath, undefined, repositoryId) : gitImageUrl("commit", oldPath, diff.base, repositoryId);
        const newUrl = file.status === "deleted" ? undefined : diff.scope === "staged" ? gitImageUrl("index", file.path, undefined, repositoryId) : diff.scope === "working" || diff.scope === "all" ? gitImageUrl("worktree", file.path, undefined, repositoryId) : gitImageUrl("commit", file.path, diff.target, repositoryId);
        store.openImageDiff({ id: `image-diff:${diff.id}:${file.path}`, type: "imageDiff", title, oldUrl, newUrl, oldLabel: diff.base, newLabel: diff.target });
        return;
      }
      if (file.truncated) return setNotice("Diff 内容超过显示限制");
      store.openDiff({ id: `diff:${diff.id}:${file.path}`, type: "diff", title, oldText: file.oldText ?? "", newText: file.newText ?? "", language: languageFor(file.path) });
    } catch (error) { setNotice(message(error)); }
  }
}

function OpenWorkspace({ path, setPath, open, error, recent, removeRecent, busy, logout }: { path: string; setPath(v: string): void; open(path?: string): void; error: string; recent: string[]; removeRecent(path: string): void; busy: boolean; logout(): void }) {
  return <div className="open-page"><div className="open-card"><button className="open-logout" onClick={logout}><LogOut/>退出登录</button><div className="logo"><Files/></div><h1>Code Workspace</h1><p>打开一个本地目录，浏览、编辑并检查 Git 修改。</p><label>工作区绝对路径</label><div className="open-input-row"><input autoFocus value={path} disabled={busy} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open()} placeholder="/home/user/project"/><button className="primary" disabled={busy} onClick={() => open()}>{busy ? "正在打开…" : "打开工作区"}</button></div>{error && <div className="error">{error}</div>}{recent.length > 0 && <section className="recent-workspaces"><h2><Clock3/>最近打开</h2>{recent.map((item) => <div className="recent-workspace" key={item}><button className="recent-open" disabled={busy} onClick={() => open(item)}><FolderOpen/><span><strong>{item.split("/").filter(Boolean).at(-1) ?? item}</strong><small>{item}</small></span><ArrowRight/></button><button className="recent-remove" title="从最近列表移除" onClick={() => removeRecent(item)}><X/></button></div>)}</section>}<small>最近路径只保存在当前浏览器。服务不会启动终端或管理任何外部工具会话。</small></div></div>;
}

function LoginPage({ onLogin }: { onLogin(): void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login() { setBusy(true); setError(""); try { await api.login(password); onLogin(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <div className="open-page"><div className="login-card"><div className="logo"><LockKeyhole/></div><h1>登录 Code Workspace</h1><p>请输入全局访问密码。</p><label>密码</label><input autoFocus type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && login()}/><button className="primary" disabled={busy || !password} onClick={login}>{busy ? "正在登录…" : "登录"}</button>{error && <div className="error">{error}</div>}</div></div>;
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
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileTreeEntry } | null>(null);
  const query = useQuery({ queryKey: ["tree", path], queryFn: () => api.tree(path), enabled: expanded.has(path) });
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); onNotice("已复制路径"); }
    catch { prompt("复制路径", text); }
  }
  async function copyAbsolute(entry: FileTreeEntry) {
    try { await copy(await api.absolutePath(entry.path)); }
    catch (e) { onNotice(message(e)); }
  }
  async function showAbsolute(entry: FileTreeEntry) {
    try { prompt("本地路径", await api.absolutePath(entry.path)); }
    catch (e) { onNotice(message(e)); }
  }
  if (query.isLoading) return <div className="tree-loading">加载中…</div>;
  return <div className="tree">{query.data?.map((entry) => <div key={entry.path}>
    <div className="tree-row" title={treeTitle(entry)} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, entry }); }} onDoubleClick={async () => {
      const next = prompt("重命名为", entry.path); if (!next || next === entry.path) return; try { await api.rename(entry.path, next); queryClient.invalidateQueries({ queryKey: ["tree"] }); } catch (e) { onNotice(message(e)); }
    }}>
      {entry.kind === "directory" ? <button onClick={() => { const next = new Set(expanded); next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path); setExpanded(next); }}>{expanded.has(entry.path) ? <ChevronDown/> : <ChevronRight/>}</button> : <span className="indent"/>}
      <span className="entry" onClick={() => entry.kind === "directory" ? undefined : onOpen(entry.path)}>{entry.kind === "directory" ? expanded.has(entry.path) ? <FolderOpen/> : <Folder/> : <File/>}<span>{entry.name}</span><GitBadge entry={entry}/>{entry.gitState && <em className={`git-${entry.gitState}`}>{stateLetter(entry.gitState)}</em>}{!entry.gitState && entry.descendantChanged && <em className="git-descendant">●</em>}</span>
      <button className="row-action" title="删除" onClick={async () => { if (!confirm(`确定删除 ${entry.path}？`)) return; try { await api.remove(entry.path, entry.kind === "directory"); queryClient.invalidateQueries({ queryKey: ["tree"] }); } catch (e) { onNotice(message(e)); } }}><Trash2/></button>
    </div>
    {entry.kind === "directory" && expanded.has(entry.path) && <div className="nested"><Tree path={entry.path} expanded={expanded} setExpanded={setExpanded} onOpen={onOpen} onNotice={onNotice}/></div>}
  </div>)}{menu && <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()}>
    <button onClick={() => { copyAbsolute(menu.entry); setMenu(null); }}><Copy/>复制绝对路径</button>
    <button onClick={() => { copy(menu.entry.path); setMenu(null); }}><Copy/>复制相对路径</button>
    <button onClick={() => { showAbsolute(menu.entry); setMenu(null); }}><ExternalLink/>查看本地路径</button>
  </div>}</div>;
}

function Changes({ repository, onDiff }: { repository: GitRepositoryInfo | null; onDiff(scope: "working" | "staged" | "all", path: string): void }) {
  const query = useQuery({ queryKey: ["git", "status", repository?.id], queryFn: () => api.gitStatus(repository?.id), retry: false, enabled: Boolean(repository) });
  if (!repository) return <PanelError text="未发现 Git 项目。可调整 GIT_DISCOVERY_DEPTH 后重新打开工作区。"/>;
  if (query.isError) return <PanelError text={message(query.error)}/>;
  const groups: Array<[string, "conflicted" | "staged" | "unstaged" | "untracked", "working" | "staged"]> = [["冲突", "conflicted", "working"], ["已暂存", "staged", "staged"], ["未暂存", "unstaged", "working"], ["未跟踪", "untracked", "working"]];
  return <><PanelTitle title="Git 修改"><button title="刷新" onClick={() => query.refetch()}><RefreshCw size={14}/></button></PanelTitle><RepositorySummary repository={repository}/><button className="wide-action" onClick={() => query.data?.files[0] && onDiff("all", query.data.files[0].path)}>查看全部修改</button>{groups.map(([title, category, scope]) => { const files = query.data?.files.filter((f) => f.categories.includes(category)) ?? []; return files.length ? <section className="change-group" key={category}><h4>{title}<span>{files.length}</span></h4>{files.map((file) => <ChangeRow key={`${category}:${file.path}`} file={file} onClick={() => onDiff(scope, file.path)}/>)}</section> : null; })}{query.data?.clean && <div className="panel-empty">工作区没有修改</div>}</>;
}

function ChangeRow({ file, onClick }: { file: GitChangedFile; onClick(): void }) { return <button className="change-row" onClick={onClick}><span>{file.path.split("/").at(-1)}</span><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}{file.additions !== undefined && ` · +${file.additions} -${file.deletions ?? 0}`}</small><em>{file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus}</em></button>; }

function HistoryPanel({ repository, onDiff }: { repository: GitRepositoryInfo | null; onDiff(hash: string, path?: string): void }) {
  const [mode, setMode] = useState<"list" | "graph">("graph");
  const [commits, setCommits] = useState<GitCommitSummary[]>([]); const [cursor, setCursor] = useState<string | null | undefined>(); const [selected, setSelected] = useState<string>();
  const page = useQuery({ queryKey: ["git", "history", repository?.id, cursor ?? "first"], queryFn: () => api.history(cursor ?? undefined, repository?.id), retry: false, enabled: mode === "list" && Boolean(repository) });
  useEffect(() => { setCommits([]); setCursor(undefined); setSelected(undefined); }, [repository?.id]);
  useEffect(() => { if (page.data) setCommits((current) => cursor ? [...current, ...page.data.items.filter((x) => !current.some((y) => y.hash === x.hash))] : page.data.items); }, [page.data]);
  const detail = useQuery({ queryKey: ["git", "commit", repository?.id, selected], queryFn: () => api.commit(selected!, repository?.id), enabled: Boolean(repository && selected) });
  if (!repository) return <PanelError text="未发现 Git 项目。可调整 GIT_DISCOVERY_DEPTH 后重新打开工作区。"/>;
  if (page.isError) return <PanelError text={message(page.error)}/>;
  return <><PanelTitle title="Git 历史"><div className="history-modes"><button className={mode === "graph" ? "active" : ""} title="提交图" onClick={() => setMode("graph")}><GitFork/></button><button className={mode === "list" ? "active" : ""} title="线性列表" onClick={() => setMode("list")}><List/></button></div></PanelTitle><RepositorySummary repository={repository}/><div className="history-workbench"><div className="history-picker">{mode === "graph" ? <CommitGraph repositoryId={repository.id} selected={selected} onSelect={setSelected}/> : <div className="history-list">{commits.map((commit) => <button key={commit.hash} className={selected === commit.hash ? "selected" : ""} onClick={() => setSelected(commit.hash)}><strong>{commit.subject}</strong><span><code>{commit.shortHash}</code>{commit.authorName}</span><time>{new Date(commit.committedAt).toLocaleString()}</time>{commit.parents.length > 1 && <em>merge</em>}</button>)}{page.data?.nextCursor && <button className="load-more" onClick={() => setCursor(page.data!.nextCursor)}>加载更多</button>}</div>}</div>{detail.data ? <CommitDetails detail={detail.data} diff={onDiff}/> : selected ? <div className="panel-empty">加载提交详情…</div> : <div className="panel-empty">选择提交查看详情</div>}</div></>;
}

function BranchPicker({ current, repositoryId, onSwitch }: { current: string | null; repositoryId?: string; onSwitch(branch: GitBranchInfo): void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = useQuery({ queryKey: ["git", "branches", repositoryId], queryFn: () => api.branches(repositoryId), enabled: open });
  const filtered = (query.data ?? []).filter((branch) => branch.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="branch-picker"><button className="branch" onClick={() => setOpen((value) => !value)}><GitBranch size={14}/><span>{current ?? "detached"}</span><ChevronDown size={13}/></button>{open && <div className="branch-popover"><label><Search/><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索分支"/></label><div className="branch-list">{["local", "remote"].map((kind) => { const entries = filtered.filter((branch) => branch.kind === kind); return entries.length ? <section key={kind}><h4>{kind === "local" ? "本地分支" : "远程分支"}</h4>{entries.map((branch) => <button key={branch.fullName} className={branch.current ? "current" : ""} onClick={() => { setOpen(false); onSwitch(branch); }}><GitBranch/><span>{branch.name}</span>{branch.current && <em>当前</em>}</button>)}</section> : null; })}{query.isLoading && <div className="panel-empty">加载分支…</div>}{query.isError && <div className="panel-empty error">{message(query.error)}</div>}</div></div>}</div>;
}

function RepositoryPicker({ repositories, current, onSelect }: { repositories: GitRepositoryInfo[]; current: GitRepositoryInfo | null; onSelect(repository: GitRepositoryInfo): void }) {
  const [open, setOpen] = useState(false);
  return <div className="repo-picker"><button className="repo-current" title={current?.repositoryRoot} onClick={() => setOpen((value) => !value)}><GitBranch size={14}/><span>{repoLabel(current)}</span><ChevronDown size={13}/></button>{open && <div className="repo-popover">{repositories.map((repository) => <button key={repository.id} className={repository.current ? "current" : ""} title={repository.repositoryRoot} onClick={() => { setOpen(false); onSelect(repository); }}><GitBranch/><span><strong>{repoLabel(repository)}</strong><small>{repository.workspacePath || "."}</small></span>{repository.current && <em>当前</em>}</button>)}</div>}</div>;
}

function RepositorySummary({ repository }: { repository: GitRepositoryInfo }) {
  return <div className="repo-summary" title={repository.repositoryRoot}><strong>{repoLabel(repository)}</strong><span>{repository.workspacePath || "."}</span></div>;
}

function CommitGraph({ repositoryId, selected, onSelect }: { repositoryId?: string; selected?: string; onSelect(hash: string): void }) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCommits([]); setCursor(0); }, [repositoryId]);
  const query = useQuery({ queryKey: ["git", "graph", repositoryId, cursor], queryFn: () => api.graph(cursor, repositoryId) });
  useEffect(() => { if (query.data) setCommits((current) => cursor ? [...current, ...query.data.items.filter((item) => !current.some((existing) => existing.hash === item.hash))] : query.data.items); }, [query.data]);
  const layout = useMemo(() => layoutCommitGraph(commits), [commits]);
  if (query.isError) return <PanelError text={message(query.error)}/>;
  return <div className="commit-graph" style={{ "--graph-width": `${layout.width}px` } as React.CSSProperties}><svg width={layout.width} height={commits.length * 60} aria-hidden="true">{layout.edges.map((edge, index) => <path key={index} d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${edge.y2}`} stroke={graphColor(edge.color)} fill="none" strokeWidth="2"/>)}{layout.nodes.map((node) => <circle key={node.hash} cx={node.x} cy={node.y} r="4.5" fill="#11161d" stroke={graphColor(node.lane)} strokeWidth="2.5"/>)}</svg><div className="graph-rows">{commits.map((commit) => <button key={commit.hash} className={selected === commit.hash ? "selected" : ""} onClick={() => onSelect(commit.hash)}><strong>{commit.subject}</strong><div className="graph-decorations">{commit.decorations.map((decoration, index) => <em className={decoration.type} key={`${decoration.name}:${index}`}>{decoration.type === "head" && "HEAD · "}{decoration.name}</em>)}</div><span><code>{commit.shortHash}</code>{commit.authorName} · {new Date(commit.committedAt).toLocaleDateString()}</span></button>)}{query.data?.nextCursor !== null && query.data?.nextCursor !== undefined && <button className="graph-load" onClick={() => setCursor(query.data!.nextCursor!)}>加载更多提交</button>}</div></div>;
}

function layoutCommitGraph(commits: GitGraphCommit[]) {
  const lanes: string[] = [];
  const nodes: Array<{ hash: string; lane: number; x: number; y: number }> = [];
  const positions = new Map<string, { lane: number; row: number }>();
  commits.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) { lane = lanes.findIndex((item) => !item); if (lane < 0) lane = lanes.length; lanes[lane] = commit.hash; }
    positions.set(commit.hash, { lane, row });
    const firstParent = commit.parents[0];
    if (!firstParent) lanes[lane] = "";
    else {
      const existing = lanes.indexOf(firstParent);
      if (existing >= 0 && existing !== lane) lanes[lane] = ""; else lanes[lane] = firstParent;
    }
    for (const parent of commit.parents.slice(1)) if (!lanes.includes(parent)) { let target = lanes.findIndex((item) => !item); if (target < 0) target = lanes.length; lanes[target] = parent; }
  });
  const width = Math.max(42, (Math.max(0, ...Array.from(positions.values()).map((item) => item.lane)) + 1) * 16 + 20);
  for (const [hash, position] of positions) nodes.push({ hash, lane: position.lane, x: 14 + position.lane * 16, y: position.row * 60 + 30 });
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number; color: number }> = [];
  for (const commit of commits) { const from = positions.get(commit.hash)!; for (const parent of commit.parents) { const to = positions.get(parent); if (to) edges.push({ x1: 14 + from.lane * 16, y1: from.row * 60 + 30, x2: 14 + to.lane * 16, y2: to.row * 60 + 30, color: to.lane }); } }
  return { width, nodes, edges };
}

function graphColor(index: number) { return ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#39c5cf", "#ff7b72"][index % 7]; }

function CommitDetails({ detail, diff }: { detail: GitCommitDetail; diff(hash: string, path?: string): void }) { return <div className="commit-detail"><h3>{detail.subject}</h3><code>{detail.hash}</code><p>{detail.body}</p><div className="commit-meta">{detail.authorName} · {new Date(detail.committedAt).toLocaleString()} · +{detail.additions} -{detail.deletions}</div><button className="wide-action" onClick={() => diff(detail.hash)}>在编辑区查看全部 Diff</button>{detail.files.map((file) => <button className="commit-file" key={`${file.status}:${file.path}`} onClick={() => diff(detail.hash, file.path)}><em>{file.status[0]}</em><span>{file.path}</span></button>)}</div>; }

function GitBadge({ entry }: { entry: FileTreeEntry }) {
  if (entry.gitTrackedState === "repository") return <small className="git-badge repo" title={treeTitle(entry)}>repo</small>;
  if (entry.gitTrackedState === "tracked" && !entry.gitState) return <small className="git-badge tracked" title={treeTitle(entry)}>T</small>;
  if (entry.gitTrackedState === "untracked" && !entry.gitState) return <small className="git-badge untracked" title={treeTitle(entry)}>U</small>;
  if (entry.gitTrackedState === "uncontrolled") return <small className="git-badge uncontrolled" title={treeTitle(entry)}>-</small>;
  return null;
}

function treeTitle(entry: FileTreeEntry) {
  const state = entry.gitTrackedState === "repository" ? `Git 项目根目录：${entry.repositoryName}` : entry.gitTrackedState === "tracked" ? `已受控：${entry.repositoryName}` : entry.gitTrackedState === "untracked" ? `未跟踪：${entry.repositoryName}` : entry.gitTrackedState === "uncontrolled" ? "不在 Git 仓库中" : "";
  return state ? `${entry.path}\n${state}` : entry.path;
}

function ConflictBar({ tab, save }: { tab: TextTab; save(tab: TextTab, version?: string): void }) {
  const store = useAppStore();
  return <div className="conflict-bar"><strong>{tab.externalState === "deleted" ? "文件已从磁盘删除" : "磁盘内容已发生变化，左侧为磁盘，右侧为编辑器"}</strong>{tab.externalState === "changed" && <><button onClick={() => { if (!confirm("使用磁盘版本并放弃编辑器修改？")) return; store.saved(tab.id, { path: tab.path, content: tab.diskText ?? "", version: tab.diskNewVersion!, encoding: "utf-8", lineEnding: "LF", size: 0, readOnly: false, binary: false, finalNewline: false }); }}>使用磁盘版本</button><button onClick={() => { if (confirm("确认用编辑器内容覆盖当前磁盘版本？")) save(tab, tab.diskNewVersion); }}>保留编辑器版本</button></>}</div>;
}

function PanelTitle({ title, children }: { title: string; children?: React.ReactNode }) { return <div className="panel-title"><strong>{title}</strong><span>{children}</span></div>; }
function PanelError({ text }: { text: string }) { return <div className="panel-empty error">{text}</div>; }
function saveStateText(tab: TextTab) {
  if (tab.saveState === "saving") return "保存中…";
  if (tab.saveState === "pending") return "等待自动保存";
  if (tab.saveState === "error") return tab.saveError ? `自动保存失败：${tab.saveError}` : "自动保存失败";
  return tab.dirty ? "未保存" : "已保存";
}
function languageFor(path: string) { const ext = path.split(".").at(-1); return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", py: "python", yml: "yaml", yaml: "yaml" } as Record<string, string>)[ext ?? ""] ?? "plaintext"; }
function stateLetter(state: string) { return ({ modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" } as Record<string, string>)[state] ?? ""; }
function isPreviewableImage(path: string) { return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path); }
function repoLabel(repository: GitRepositoryInfo | null) { return repository ? `${repository.workspacePath || repository.name} · ${repository.branch ?? "detached"}` : "无 Git 项目"; }
function gitImageUrl(source: "worktree" | "index" | "head" | "commit", path: string, hash?: string, repositoryId?: string) { return `/api/git/image?source=${source}&path=${encodeURIComponent(path)}${hash ? `&hash=${encodeURIComponent(hash)}` : ""}${repositoryId ? `&repositoryId=${encodeURIComponent(repositoryId)}` : ""}`; }
function ImageDiffSide({ label, url }: { label: string; url?: string }) { return <section><header>{label}</header><div>{url ? <img src={url} alt={label}/> : <span>此版本中不存在图片</span>}</div></section>; }
