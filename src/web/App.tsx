import { useEffect, useRef, useState } from "react";
import Editor from "./CodeEditor";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, ChevronRight, ChevronsRight, Clock3, Copy, ExternalLink, File, Folder, FolderOpen, GitBranch, GitFork, LogOut, RefreshCw, Save, Search, X, Files, Layers2, Plus, Trash2, XCircle } from "lucide-react";
import type { FileTreeEntry, GitBranchInfo, GitRepositoryInfo, GitWorktree, WorkspaceChangeSummary, WorkspaceInfo } from "../shared/contracts";
import { DiffViewer } from "./DiffViewer";
import { WorktreePanel } from "./GitPanels";
import { GitWorkspace, RepositorySidebar } from "./GitWorkspace";
import { api, ApiClientError, apiSessionId } from "./api";
import { type TextTab, useAppStore } from "./store";

type View = "files" | "changes" | "history" | "worktrees";
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

export function App({ onLogout = () => undefined }: { onLogout?: () => void }) {
  const store = useAppStore();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>("files");
  const [lastGitView, setLastGitView] = useState<"changes" | "history">("changes");
  const [repositoryScope, setRepositoryScope] = useState("all");
  const [historyWorktree, setHistoryWorktree] = useState<GitWorktree>();
  const [worktreeFocusRequest, setWorktreeFocusRequest] = useState(0);
  const [historyFocusRequest, setHistoryFocusRequest] = useState(0);
  const [focusHash, setFocusHash] = useState<string>();
  const [focusWorktree, setFocusWorktree] = useState<string>();
  const [watchNotice, setWatchNotice] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [notice, setNotice] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const workspaceRequest = useRef(0);
  const active = store.tabs.find((tab) => tab.id === store.activeId) ?? null;
  const currentRepository = store.workspace?.git ?? null;
  const initialization = store.workspace?.initialization;
  const gitReady = !initialization || initialization.status === "ready";

  useEffect(() => {
    let active = true;
    const request = workspaceRequest.current;
    api.workspaceSnapshot().then((workspace) => { if (active && request === workspaceRequest.current) { store.setWorkspace(workspace); rememberWorkspace(workspace.rootPath); } }).catch(() => undefined);
    return () => { active = false; ++workspaceRequest.current; };
  }, []);
  useEffect(() => {
    if (initialization?.status !== "loading") return;
    const id = initialization.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const workspace = await api.workspaceSnapshot();
        if (cancelled || useAppStore.getState().workspace?.initialization?.id !== id || workspace.initialization?.id !== id) return;
        setWorkspaceLoadError("");
        store.setWorkspace(workspace);
        if (workspace.initialization.status !== "loading") {
          void queryClient.invalidateQueries({ queryKey: ["tree"] });
          void queryClient.invalidateQueries({ queryKey: ["git"] });
          return;
        }
      } catch (error) { if (!cancelled) setWorkspaceLoadError(`加载状态读取失败：${message(error)}`); }
      if (!cancelled) timer = setTimeout(poll, 300);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [initialization?.id, initialization?.status]);
  useEffect(() => {
    if (!store.workspace) return;
    const send = () => {
      const state = useAppStore.getState();
      if (!state.workspace) return;
      const paths = state.tabs.flatMap(t => t.type === "text" || t.type === "image" ? [t.path] : []);
      const dirtyPaths = state.tabs.flatMap(t => t.type === "text" && t.dirty ? [t.path] : []);
      void api.editorState(state.workspace.id, paths, dirtyPaths).catch(() => undefined);
    };
    send(); const timer = setInterval(send, 15000);
    return () => clearInterval(timer);
  }, [store.workspace?.id, store.tabs]);
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
    let connected = true;
    ws.onmessage = async ({ data }) => {
      if (!connected) return;
      const envelope = JSON.parse(data);
      const event = envelope.event;
      if (!event) { if (envelope.type === "workspace.resyncRequired") { queryClient.invalidateQueries(); store.markDiffsStale(); } return; }
      if (event.type.startsWith("file.") && event.path) {
        queryClient.invalidateQueries({ queryKey: ["tree"] });
        const tab = store.tabs.find((t) => (t.type === "text" || t.type === "image") && t.path === event.path);
        if (tab) {
          if (event.type === "file.deleted") tab.type === "image" ? store.refreshImage(event.path, null) : store.external(event.path, null);
          else api.file(event.path).then((file) => { if (connected) tab.type === "image" ? store.refreshImage(event.path!, file) : store.external(event.path!, file); }).catch(() => undefined);
        }
      }
      if (event.type.startsWith("watcher.")) setWatchNotice("部分监听不可用，请使用刷新本地快照读取最新状态");
      if (event.type.startsWith("directory.")) queryClient.invalidateQueries({ queryKey: ["tree"] });
      if (event.type.startsWith("git.")) {
        queryClient.invalidateQueries({ queryKey: ["git"] });
        api.workspace().then((workspace) => { if (useAppStore.getState().workspace?.initialization?.id === workspace.initialization?.id) store.setWorkspace(workspace); }).catch(() => undefined);
        store.markDiffsStale();
      }
    };
    return () => { connected = false; ws.close(); };
  }, [store.workspace?.id, store.workspace?.openedAt]);
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
    if (switchingWorkspace) return;
    ++workspaceRequest.current;
    setSwitchingWorkspace(true);
    try { const ws = await api.openWorkspace(target); store.clear(); store.setWorkspace(ws); queryClient.clear(); setWorkspaceLoadError(""); setWatchNotice(""); setWorkspacePath(ws.rootPath); rememberWorkspace(ws.rootPath); setNotice(""); setFocusHash(undefined); setFocusWorktree(undefined); setHistoryWorktree(undefined); setRepositoryScope("all"); setView("files"); }
    catch (error) { setNotice(message(error)); }
    finally { setSwitchingWorkspace(false); }
  }
  async function switchWorkspace() {
    if (store.tabs.some((tab) => tab.type === "text" && tab.dirty) && !confirm("存在未保存文件，确定切换工作区吗？")) return;
    ++workspaceRequest.current;
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
  async function retryWorkspace() {
    const id = useAppStore.getState().workspace?.initialization?.id;
    if (!id) return;
    setWorkspaceLoadError("");
    try {
      const workspace = await api.retryWorkspace(id);
      if (useAppStore.getState().workspace?.initialization?.id === id) store.setWorkspace(workspace);
    } catch (error) { setWorkspaceLoadError(message(error)); }
  }
  async function switchBranch(branch: GitBranchInfo) {
    if (branch.current) return;
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
      setFocusHash(undefined);
      setHistoryWorktree(undefined);
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
      return true;
    } catch (error) { setNotice(`切换 Git 项目失败：${message(error)}`); return false; }
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

  if (!store.workspace) return <OpenWorkspace path={workspacePath} setPath={setWorkspacePath} open={openWorkspace} error={notice} recent={recentWorkspaces} removeRecent={removeRecentWorkspace} busy={switchingWorkspace} logout={async () => { await api.logout(); onLogout(); }} />;
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

  function showWorktree(id: string) { setFocusWorktree(id); setWorktreeFocusRequest(n => n + 1); setView("worktrees"); }
  async function navigateWorktree(worktree: GitWorktree, target: "history" | "changes") {
    try {
      const repositories = worktree.repositoryId ? await api.repositories() : store.workspace!.repositories;
      const repository = worktree.repositoryId ? repositories.find(r => r.id === worktree.repositoryId) : repositories.find(r => r.repositoryGroupId === worktree.repositoryGroupId);
      if (!repository) { setNotice("所属本地仓库不可访问，请刷新状态后重试"); return; }
      if (!await selectRepository(repository)) return;
      setHistoryWorktree(worktree.repositoryId ? undefined : worktree);
      setFocusHash(worktree.head ?? undefined); if (target === "history") setHistoryFocusRequest(n => n + 1); setLastGitView(target); setView(target);
    } catch (error) { setNotice(message(error)); }
  }
  async function chooseScope(scope: string, groupId?: string) {
    setRepositoryScope(scope);
    if (view === "files" || view === "worktrees") return;
    if (scope === "all") { setView("worktrees"); return; }
    const repository = store.workspace!.repositories.find(r => r.repositoryGroupId === groupId && r.current) ?? store.workspace!.repositories.find(r => r.repositoryGroupId === groupId);
    if (repository && await selectRepository(repository)) { setFocusHash(undefined); setHistoryWorktree(undefined); }
    else if (!repository) { setView("worktrees"); setNotice("请选择该本地仓库中的工作目录"); }
  }
  function showGit(tab: "changes" | "history") { setLastGitView(tab); setView(tab); }

  return <div className={`app-shell ${view !== "files" ? "workspace-mode" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <header className="topbar">
      <div className="brand">Code Workspace</div><div className="workspace-name">{store.workspace.name}</div>
      {!gitReady && <span className="workspace-load-state">{workspaceLoadingText(store.workspace)}</span>}
      {gitReady && view === "files" && store.workspace.repositories.length > 0 && (
        <RepositoryPicker repositories={store.workspace.repositories} current={currentRepository} onSelect={selectRepository}/>
      )}
      {gitReady && view === "files" && currentRepository && (
        <BranchPicker current={currentRepository.branch} repositoryId={currentRepository.id} onSwitch={switchBranch}/>
      )}
      <button className="icon-button" title="刷新本地快照（不连接远程）" onClick={async () => { try { await queryClient.invalidateQueries(); const id = store.workspace?.initialization?.id; const workspace = await api.workspace(); if (useAppStore.getState().workspace?.initialization?.id === id) store.setWorkspace(workspace); } catch (error) { setNotice(message(error)); } }}><RefreshCw size={16}/></button>
      <button className="close-workspace" disabled={switchingWorkspace} onClick={switchWorkspace}>{switchingWorkspace ? "正在切换…" : "切换工作区"}</button>
      <button className="logout-button" title="退出登录" onClick={async () => { await api.logout(); store.clear(); queryClient.clear(); onLogout(); }}><LogOut size={15}/></button>
    </header>
    <aside className="activitybar">
      <NavButton active={view === "files"} title="文件" onClick={() => setView("files")}><Files/></NavButton>
      <NavButton active={view === "worktrees"} title="Worktree" onClick={() => setView("worktrees")}><GitFork/></NavButton>
      <NavButton active={view === "changes" || view === "history"} title="Git" onClick={() => setView(lastGitView)}><GitBranch/></NavButton>
    </aside>
    <aside className="sidebar">
      {view === "files" && <Explorer key={store.workspace.openedAt}
        onOpen={async (path) => { const openedAt = store.workspace?.openedAt; try { const file = await api.file(path); if (useAppStore.getState().workspace?.openedAt !== openedAt) return; if (file.binary && isPreviewableImage(path)) store.openImage(file); else if (file.binary) setNotice("该二进制文件暂不支持预览"); else if (file.content === null) setNotice("文件过大或编码不受支持，已阻止编辑"); else store.openFile(file); } catch (e) { if (useAppStore.getState().workspace?.openedAt === openedAt) setNotice(message(e)); } }}
        onNotice={setNotice}
      />}
      {view !== "files" && (gitReady ? <RepositorySidebar scope={view === "worktrees" ? repositoryScope : currentRepository ? `base:${currentRepository.repositoryGroupId}` : "all"} onScope={chooseScope} current={currentRepository}/> : <p className="panel-empty">{workspaceLoadingText(store.workspace)}</p>)}
    </aside>
    <div className="sidebar-resizer" title="拖拽调整侧栏宽度，双击恢复默认" onPointerDown={startSidebarResize} onDoubleClick={resetSidebarWidth}/>
    <div className="workbench-area" hidden={view !== "worktrees"}>{gitReady ? <WorktreePanel key={store.workspace.openedAt} scope={repositoryScope} onScopeChange={setRepositoryScope} active={view === "worktrees"} focusWorktree={focusWorktree} focusRequest={worktreeFocusRequest} onNavigate={navigateWorktree}/> : <div className="workbench-page"><h1>Worktree</h1><WorkspaceLoading workspace={store.workspace} error={workspaceLoadError} retry={retryWorkspace}/></div>}</div>
    <div className="workbench-area" hidden={view !== "changes" && view !== "history"}>{gitReady ? <GitWorkspace key={store.workspace.openedAt} repository={currentRepository} tab={view === "history" ? "history" : view === "changes" ? "changes" : lastGitView} onTab={showGit} active={view === "changes" || view === "history"} focusHash={focusHash} focusRequest={historyFocusRequest} historyWorktree={historyWorktree} onWorktree={showWorktree} branchPicker={currentRepository && <BranchPicker current={currentRepository.branch} repositoryId={currentRepository.id} onSwitch={switchBranch}/>}/> : <div className="workbench-page"><h1>Git</h1><WorkspaceLoading workspace={store.workspace} error={workspaceLoadError} retry={retryWorkspace}/></div>}</div>
    <main className="editor-area" hidden={view !== "files"}>
      <div className="tab-strip">
        <div className="tabs">{store.tabs.map((tab) => <div key={tab.id} className={`tab ${tab.id === store.activeId ? "active" : ""}`} title={tabTooltip(tab)} onClick={() => store.activate(tab.id)}>
          <span>{tabLabel(tab)}</span>{tab.type === "text" && tab.dirty && <i>●</i>}{(tab.type === "text" || tab.type === "image") && tab.externalState !== "current" && <b>!</b>}{(tab.type === "diff" || tab.type === "imageDiff") && tab.stale && <b>!</b>}<button title="关闭当前 (Ctrl/Cmd+W)" onClick={(e) => { e.stopPropagation(); store.closeTab(tab.id); }}><X size={13}/></button>
        </div>)}</div>
        <div className="tab-actions">
          <button disabled={!store.activeId || store.tabs.length < 2} title="关闭其他 (Alt+Shift+O)" onClick={() => store.activeId && store.closeOtherTabs(store.activeId)}><Layers2/></button>
          <button disabled={!store.activeId || store.tabs.findIndex((tab) => tab.id === store.activeId) === store.tabs.length - 1} title="关闭右侧 (Alt+Shift+R)" onClick={() => store.activeId && store.closeTabsToRight(store.activeId)}><ChevronsRight/></button>
          <button disabled={!store.tabs.length} title="关闭全部 (Alt+Shift+A)" onClick={() => store.closeAllTabs()}><XCircle/></button>
        </div>
      </div>
      {!gitReady && <WorkspaceLoading workspace={store.workspace} error={workspaceLoadError} retry={retryWorkspace}/>}
      {!active && <div className="empty"><Files size={52}/><h2>选择文件开始编辑</h2><p>{gitReady ? "外部程序的文件修改会自动同步到这里。" : "可以先浏览和编辑文件，Git 信息与文件监听将在加载完成后更新。"}</p></div>}
      {active?.type === "text" && <>
        {active.externalState !== "current" && (
          <ConflictBar tab={active} save={save}/>
        )}
        <div className="editor-toolbar"><span>{active.path}</span><span>{saveStateText(active)}</span><button disabled={!active.dirty || active.externalState !== "current" || active.saveState === "saving"} onClick={() => save(active)}><Save size={15}/>保存</button></div>
        {active.externalState === "changed" && active.diskText !== undefined ? <DiffViewer key={active.id} height="100%" theme="vs-dark" original={active.diskText} modified={active.bufferText} language={active.language} options={{ originalEditable: false, automaticLayout: true }}/>
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
      {active?.type === "diff" && <><div className={`editor-toolbar ${active.stale ? "stale" : ""}`}><span>{active.title}</span>{active.stale && <span>Git 状态已变化，请重新打开此 Diff</span>}</div><DiffViewer key={active.id} height="100%" theme="vs-dark" original={active.oldText} modified={active.newText} language={active.language} options={{ readOnly: true, originalEditable: false, automaticLayout: true, renderSideBySide: window.innerWidth > 800 }}/></>}
      {active?.type === "imageDiff" && <><div className={`editor-toolbar ${active.stale ? "stale" : ""}`}><span>{active.title}</span>{active.stale && <span>Git 状态已变化，请重新打开此 Diff</span>}</div><div className="image-diff"><ImageDiffSide label={active.oldLabel} url={active.oldUrl}/><ImageDiffSide label={active.newLabel} url={active.newUrl}/></div></>}
      {active?.type === "image" && <><div className="editor-toolbar"><span>{active.path}</span><span>图片预览</span></div><div className="image-preview">{active.externalState === "deleted" ? <div className="image-missing">图片已从磁盘删除</div> : <img src={`/api/files/raw?sessionId=${encodeURIComponent(apiSessionId())}&path=${encodeURIComponent(active.path)}&v=${encodeURIComponent(active.version)}`} alt={active.path}/>}</div></>}
    </main>
    <footer className="statusbar"><span>{notice || watchNotice || (!gitReady ? workspaceLoadingText(store.workspace) : "就绪")}</span><span>{active?.type === "text" ? `${active.dirty ? "未保存" : "已保存"} · ${active.externalState}` : ""}</span></footer>
  </div>;

}

function workspaceLoadingText(workspace: WorkspaceInfo) {
  const state = workspace.initialization;
  if (state?.status === "error") return "Git 信息加载失败";
  return ({ discovery: "正在扫描 Git 仓库…", groups: "正在读取 Worktree…", status: "正在统计文件变更…", watching: "正在启动文件监听…" })[state?.phase ?? "discovery"];
}

function WorkspaceLoading({ workspace, error, retry }: { workspace: WorkspaceInfo; error: string; retry(): void }) {
  const failed = workspace.initialization?.status === "error";
  return <div className={`workspace-loading-note ${failed || error ? "failed" : ""}`} role={failed || error ? "alert" : "status"} aria-live="polite">
    <RefreshCw size={16} className={failed || error ? "" : "loading-spin"}/><div><strong>{workspaceLoadingText(workspace)}</strong><p>{error || workspace.initialization?.error || "工作区已打开，文件可以先查看。Git 信息加载完成后会自动更新。"}</p></div>
    {(failed || error) && <button onClick={retry}>重试加载</button>}
  </div>;
}

function OpenWorkspace({ path, setPath, open, error, recent, removeRecent, busy, logout }: { path: string; setPath(v: string): void; open(path?: string): void; error: string; recent: string[]; removeRecent(path: string): void; busy: boolean; logout(): void }) {
  const summaries = useQuery({ queryKey: ["workspace-change-summary", recent], queryFn: () => api.workspaceChangeSummary(recent), enabled: recent.length > 0, staleTime: 30_000 });
  const summaryMap = new Map((summaries.data ?? []).map((summary) => [summary.path, summary]));
  return <div className="open-page"><div className="open-card"><button className="open-logout" onClick={logout}><LogOut/>退出登录</button><div className="logo"><Files/></div><h1>Code Workspace</h1><p>打开一个本地目录，浏览、编辑并检查 Git 修改。</p><label>工作区绝对路径</label><div className="open-input-row"><input autoFocus value={path} disabled={busy} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && open()} placeholder="/home/user/project"/><button className="primary" disabled={busy} onClick={() => open()}>{busy ? "正在打开…" : "打开工作区"}</button></div>{error && <div className="error">{error}</div>}{recent.length > 0 && <section className="recent-workspaces"><h2><Clock3/>最近打开</h2>{recent.map((item) => {
    const summary = summaryMap.get(item);
    return <div className="recent-workspace" key={item}><button className="recent-open" disabled={busy} title={workspaceSummaryTitle(summary)} onClick={() => open(item)}><FolderOpen/><span><strong>{item.split("/").filter(Boolean).at(-1) ?? item}</strong><small>{item}</small></span>{summary && <ChangeCountBadge count={summary.changedFileCount} title={workspaceSummaryTitle(summary)}/>}<ArrowRight/></button><button className="recent-remove" title="从最近列表移除" onClick={() => removeRecent(item)}><X/></button></div>;
  })}</section>}<small>最近路径只保存在当前浏览器。服务不会启动终端或管理任何外部工具会话。</small></div></div>;
}

function NavButton({ active, title, onClick, children }: { active: boolean; title: string; onClick(): void; children: React.ReactNode }) { return <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} title={title} onClick={onClick}>{children}<span>{title}</span></button>; }

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
  if (query.isError) return <div className="tree-loading error" role="alert">{message(query.error)} <button onClick={() => query.refetch()}>重试</button></div>;
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

function BranchPicker({ current, repositoryId, onSwitch }: { current: string | null; repositoryId?: string; onSwitch(branch: GitBranchInfo): void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const picker = useRef<HTMLDivElement>(null);
  const workspace = useAppStore(state => state.workspace);
  const repository = workspace?.repositories.find(item => item.id === repositoryId);
  const query = useQuery({ queryKey: ["git", "branches", repositoryId], queryFn: () => api.branches(repositoryId), enabled: open });
  const worktrees = useQuery({ queryKey: ["git", "worktrees"], queryFn: api.worktrees, enabled: open, retry: false });
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); picker.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { setOpen(false); setSearch(""); }, [repositoryId]);
  const filtered = (query.data ?? []).filter(branch => branch.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="branch-picker" ref={picker}><button className="branch" aria-label="切换分支" aria-expanded={open} title={current ?? "detached HEAD"} onClick={() => setOpen(value => !value)}><GitBranch size={14}/><span>{current ?? "detached HEAD"}</span><ChevronDown size={13}/></button>{open && <div className="branch-popover"><label><Search/><input autoFocus aria-label="搜索分支" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索分支"/></label><div className="branch-list">{["local", "remote"].map(kind => {
    const entries = filtered.filter(branch => branch.kind === kind);
    return entries.length ? <section key={kind}><h4>{kind === "local" ? "本地分支" : "远程分支"}</h4>{entries.map(branch => {
      const occupied = branch.kind === "local" && worktrees.data?.groups.find(group => group.repositoryGroupId === repository?.repositoryGroupId)?.worktrees.find(worktree => worktree.branch === branch.name && worktree.worktreeId !== repository?.worktreeId);
      return <button key={branch.fullName} disabled={branch.current || Boolean(occupied)} className={branch.current ? "current" : ""} title={occupied ? `已在 ${occupied.path} 使用` : branch.name} onClick={() => { setOpen(false); onSwitch(branch); }}><GitBranch/><span>{branch.name}</span>{branch.current ? <em>当前</em> : occupied ? <em>已被 Worktree 使用</em> : null}</button>;
    })}</section> : null;
  })}{query.isLoading && <div className="panel-empty">加载分支…</div>}{query.isError && <div className="panel-empty error">{message(query.error)}</div>}{query.data && !filtered.length && <div className="panel-empty">没有匹配的分支</div>}</div><p className="branch-picker-note">此处切换工作目录；浏览历史请使用历史范围筛选。</p></div>}</div>;
}

function RepositoryPicker({ repositories, current, onSelect }: { repositories: GitRepositoryInfo[]; current: GitRepositoryInfo | null; onSelect(repository: GitRepositoryInfo): void }) {
  const [open, setOpen] = useState(false);
  return <div className="repo-picker"><button className="repo-current" title={repositoryTitle(current)} onClick={() => setOpen((value) => !value)}><GitBranch size={14}/><span>{repoLabel(current)}</span>{current && <ChangeCountBadge count={current.changedFileCount} title={repositoryTitle(current)}/>}<ChevronDown size={13}/></button>{open && <div className="repo-popover">{repositories.map((repository) => <button key={repository.id} className={repository.current ? "current" : ""} title={repositoryTitle(repository)} onClick={() => { setOpen(false); onSelect(repository); }}><GitBranch/><span><strong>{repoLabel(repository)}</strong><small>{repository.workspacePath || "."}</small></span><ChangeCountBadge count={repository.changedFileCount} title={repositoryTitle(repository)}/>{repository.current && <em>当前</em>}</button>)}</div>}</div>;
}

function GitBadge({ entry }: { entry: FileTreeEntry }) {
  if (entry.gitTrackedState === "repository") return <><small className="git-badge repo" title={treeTitle(entry)}>repo</small><ChangeCountBadge count={entry.repositoryChangedFileCount} title={treeTitle(entry)}/></>;
  if (entry.gitTrackedState === "tracked" && !entry.gitState) return <small className="git-badge tracked" title={treeTitle(entry)}>T</small>;
  if (entry.gitTrackedState === "untracked" && !entry.gitState) return <small className="git-badge untracked" title={treeTitle(entry)}>U</small>;
  if (entry.gitTrackedState === "uncontrolled") return <small className="git-badge uncontrolled" title={treeTitle(entry)}>-</small>;
  return null;
}

function treeTitle(entry: FileTreeEntry) {
  const state = entry.gitTrackedState === "repository" ? `Git 项目根目录：${entry.repositoryName}` : entry.gitTrackedState === "tracked" ? `已受控：${entry.repositoryName}` : entry.gitTrackedState === "untracked" ? `未跟踪：${entry.repositoryName}` : entry.gitTrackedState === "uncontrolled" ? "不在 Git 仓库中" : "";
  const count = entry.gitTrackedState === "repository" ? `\n变更文件：${entry.repositoryChangedFileCount ?? "未知"}` : "";
  return state ? `${entry.path}\n${state}${count}` : entry.path;
}

function ChangeCountBadge({ count, title }: { count: number | undefined; title?: string }) {
  return <small className={`change-count ${count === undefined ? "unknown" : count > 0 ? "dirty" : "clean"}`} title={title ?? `变更文件：${count ?? "未知"}`}>{count ?? "?"}</small>;
}

function repositoryTitle(repository: GitRepositoryInfo | null) {
  if (!repository) return "无 Git 项目";
  return `${repository.repositoryRoot}\n变更文件：${repository.changedFileCount ?? "未知"}`;
}

function workspaceSummaryTitle(summary?: WorkspaceChangeSummary) {
  if (!summary) return "正在读取变更数量";
  if (summary.error) return summary.error;
  return `受控项目：${summary.repositoryCount}\n有变更项目：${summary.changedRepositoryCount}\n变更文件：${summary.changedFileCount}`;
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
function tabLabel(tab: ReturnType<typeof useAppStore.getState>["tabs"][number]) {
  if (tab.type === "text" || tab.type === "image") return fileName(tab.path);
  const path = tab.title.includes(": ") ? tab.title.split(": ").at(-1) ?? tab.title : tab.title;
  return path === "全部修改" ? path : fileName(path);
}
function tabTooltip(tab: ReturnType<typeof useAppStore.getState>["tabs"][number]) {
  return tab.type === "diff" || tab.type === "imageDiff" ? tab.title : tab.path;
}
function languageFor(path: string) { const ext = path.split(".").at(-1); return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", py: "python", yml: "yaml", yaml: "yaml" } as Record<string, string>)[ext ?? ""] ?? "plaintext"; }
function fileName(path: string) { return path.split("/").filter(Boolean).at(-1) ?? path; }
function stateLetter(state: string) { return ({ modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" } as Record<string, string>)[state] ?? ""; }
function isPreviewableImage(path: string) { return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path); }
function repoLabel(repository: GitRepositoryInfo | null) { return repository ? `${repository.workspacePath || repository.name} · ${repository.branch ?? "detached"}` : "无 Git 项目"; }
function ImageDiffSide({ label, url }: { label: string; url?: string }) { return <section><header>{label}</header><div>{url ? <img src={url} alt={label}/> : <span>此版本中不存在图片</span>}</div></section>; }
