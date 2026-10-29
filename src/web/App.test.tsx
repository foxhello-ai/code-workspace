// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceInfo } from "../shared/contracts";
import { App } from "./App";
import { api, ApiClientError } from "./api";
import { useAppStore } from "./store";

vi.mock("./CodeEditor", () => ({ default: ({ value }: { value: string }) => <textarea aria-label="编辑器" value={value} readOnly/> }));
vi.mock("./DiffViewer", () => ({ DiffViewer: () => <div/> }));
const loading: WorkspaceInfo = { id: "workspace", name: "project", rootPath: "/project", openedAt: "2026-10-29T00:00:00Z", git: null, repositories: [], repositoryDiscovery: { depth: 2, maxDirs: 100, checkedDirs: 0, timedOut: false, truncated: false }, initialization: { id: "opening-1", status: "loading", phase: "discovery" } };
const ready: WorkspaceInfo = { ...loading, initialization: { ...loading.initialization!, status: "ready" } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } });
  return render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
}
async function open() {
  const input = await screen.findByPlaceholderText("/home/user/project");
  fireEvent.change(input, { target: { value: "/project" } });
  fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
  await screen.findByRole("button", { name: "切换工作区" });
}
beforeEach(() => {
  useAppStore.getState().clear(); localStorage.clear();
  vi.stubGlobal("WebSocket", class { onmessage = null; close() {} });
  vi.spyOn(api, "authStatus").mockResolvedValue({ authenticated: true });
  vi.spyOn(api, "workspaceSnapshot").mockRejectedValue(new ApiClientError(404, "WORKSPACE_NOT_OPEN", "尚未打开工作区"));
  vi.spyOn(api, "openWorkspace").mockResolvedValue(loading);
  vi.spyOn(api, "closeWorkspace").mockResolvedValue(null);
  vi.spyOn(api, "editorState").mockResolvedValue(null);
  vi.spyOn(api, "workspaceChangeSummary").mockResolvedValue([]);
  vi.spyOn(api, "tree").mockResolvedValue([{ path: "hello.txt", name: "hello.txt", kind: "file", hidden: false, expandable: false, gitState: null }]);
  vi.spyOn(api, "file").mockResolvedValue({ path: "hello.txt", content: "read before Git", version: "v1", size: 15, binary: false, readOnly: false, encoding: "utf-8", lineEnding: "LF", finalNewline: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.getState().clear(); });

it("enters the shell and opens files before Git is ready, then preserves tabs when ready", async () => {
  mount(); await screen.findByPlaceholderText("/home/user/project");
  const completion = deferred<WorkspaceInfo>();
  vi.mocked(api.workspaceSnapshot).mockReturnValue(completion.promise);
  const git = vi.spyOn(api, "gitStatus");
  const worktrees = vi.spyOn(api, "worktrees");
  await open();
  fireEvent.click(await screen.findByText("hello.txt"));
  expect((await screen.findByRole("textbox", { name: "编辑器" }) as HTMLTextAreaElement).value).toBe("read before Git");
  fireEvent.click(screen.getByTitle("Git"));
  expect(screen.getByRole("heading", { name: "Git" })).toBeTruthy();
  expect(screen.queryByText(/未发现 Git 项目/)).toBeNull();
  expect(git).not.toHaveBeenCalled(); expect(worktrees).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle("Worktree"));
  expect(screen.getByRole("heading", { name: "Worktree" })).toBeTruthy();
  fireEvent.click(screen.getByTitle("文件"));
  await screen.findByText("hello.txt", { selector: ".entry>span" });
  const treeReads = vi.mocked(api.tree).mock.calls.length;
  await act(async () => completion.resolve(ready));
  await waitFor(() => expect(useAppStore.getState().workspace?.initialization?.status).toBe("ready"));
  expect(useAppStore.getState().tabs).toHaveLength(1);
  expect((screen.getByRole("textbox", { name: "编辑器" }) as HTMLTextAreaElement).value).toBe("read before Git");
  expect(api.tree).toHaveBeenCalledTimes(treeReads + 1); // refreshed for Git decorations
});

it("keeps the workspace and open files on failure and retries in place", async () => {
  mount(); await screen.findByPlaceholderText("/home/user/project");
  vi.mocked(api.workspaceSnapshot).mockResolvedValue({ ...loading, initialization: { ...loading.initialization!, status: "error", error: "scan failed" } });
  vi.spyOn(api, "retryWorkspace").mockResolvedValue({ ...loading, initialization: { ...loading.initialization!, id: "opening-2" } });
  await open();
  fireEvent.click(await screen.findByText("hello.txt"));
  await screen.findByRole("textbox", { name: "编辑器" });
  const retry = await screen.findByRole("button", { name: "重试加载" });
  vi.mocked(api.workspaceSnapshot).mockResolvedValue({ ...ready, initialization: { ...ready.initialization!, id: "opening-2" } });
  fireEvent.click(retry);
  await waitFor(() => expect(useAppStore.getState().workspace?.initialization?.status).toBe("ready"));
  expect(api.retryWorkspace).toHaveBeenCalledWith("opening-1");
  expect(api.openWorkspace).toHaveBeenCalledOnce();
  expect(useAppStore.getState().tabs).toHaveLength(1);
});

it("discards a pending snapshot after the workspace is closed", async () => {
  mount(); await screen.findByPlaceholderText("/home/user/project");
  const old = deferred<WorkspaceInfo>(); vi.mocked(api.workspaceSnapshot).mockReturnValue(old.promise);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "切换工作区" }));
  await screen.findByPlaceholderText("/home/user/project");
  await act(async () => old.resolve(ready));
  expect(useAppStore.getState().workspace).toBeNull();
});

it("restores the loading workspace directly on page reload", async () => {
  vi.mocked(api.workspaceSnapshot).mockResolvedValue(loading);
  mount();
  await screen.findByRole("button", { name: "切换工作区" });
  expect(api.openWorkspace).not.toHaveBeenCalled();
  expect(screen.queryByPlaceholderText("/home/user/project")).toBeNull();
  expect(useAppStore.getState().workspace?.initialization?.status).toBe("loading");
});

it("shows a path validation error without entering the shell", async () => {
  vi.mocked(api.openWorkspace).mockRejectedValue(new ApiClientError(404, "PATH_NOT_FOUND", "工作区目录不存在"));
  mount();
  const input = await screen.findByPlaceholderText("/home/user/project");
  fireEvent.change(input, { target: { value: "/missing" } });
  fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
  await screen.findByText("工作区目录不存在");
  expect(useAppStore.getState().workspace).toBeNull();
});
