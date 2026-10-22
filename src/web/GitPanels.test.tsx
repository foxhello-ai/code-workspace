// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitCommitDetail, GitGraphCommit, GitHistoryPage, GitRepositoryInfo, WorktreeOverview, WorktreeStatus } from "../shared/contracts";
import { HistoryPanel, WorktreePanel } from "./GitPanels";
import { api } from "./api";

const repository: GitRepositoryInfo = { id: "repo", repositoryGroupId: "group", worktreeId: "main", commonDir: "/repo/.git", name: "repo", workspacePath: "repo", repositoryRoot: "/repo", branch: "trunk", head: "a".repeat(40), detached: false, current: true, discoveryDepth: 1 };
const commit = (hash: string, subject: string, local = true, remote = true): GitGraphCommit => ({ hash: hash.repeat(40), shortHash: hash.repeat(8), parents: [], subject, authorName: "Tester", authorEmail: "test@example.com", authoredAt: "2026-10-22T00:00:00Z", committedAt: "2026-10-22T00:00:00Z", decorations: [], inCurrentHistory: local, inRemoteHistory: remote });
const page = (items: GitGraphCommit[], extra: Partial<GitHistoryPage> = {}): GitHistoryPage => ({ items, nextCursor: null, head: repository.head, graphRevision: "v1", scope: "all", total: items.length, shallow: false, comparison: { upstream: "refs/remotes/origin/trunk", ahead: 1, behind: 2 }, ...extra });
const worktree = (id: string, clean: boolean | null, main = false): WorktreeStatus => ({ worktreeId: id, repositoryGroupId: id, path: `/workspace/${id}`, workspacePath: id, head: repository.head, branch: "trunk", main, current: main, inWorkspace: true, missing: false, bare: false, readAt: "2026-10-22T00:00:00Z", status: clean === null ? null : { repositoryId: id, revision: 1, branch: "trunk", head: repository.head, detached: false, clean, files: clean ? [] : [{ path: "a.txt", indexStatus: ".", worktreeStatus: "M", categories: ["unstaged"] }], counts: { conflicted: 0, staged: 0, unstaged: clean ? 0 : 1, untracked: 0 } }, upstream: null, unpublished: null, defaultBranch: null, defaultRelation: "unknown", syncNote: "本地快照" });
const group = (name: string, worktrees: WorktreeStatus[], url = `https://example.com/${name}.git`): WorktreeOverview["groups"][number] => ({ name, repositoryGroupId: name, commonDir: `/${name}/.git`, worktrees, truncated: false, changedFileCount: 0, unknownCount: 0, remote: { primaryName: "origin", primaryUrl: url, remotes: [{ name: "origin", fetchUrls: [url], pushUrls: [url] }] } });

function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
beforeEach(() => {
  vi.spyOn(api, "sync").mockResolvedValue(null);
  vi.spyOn(api, "refs").mockResolvedValue([]);
  vi.spyOn(api, "commit").mockImplementation(async hash => ({ ...commit("a", "Selected commit"), hash, body: "", committerName: "Tester", committerEmail: "test@example.com", files: [], additions: 0, deletions: 0 } satisfies GitCommitDetail));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("WT-09/10: counts globally, sorts across repositories and opens details only on request", async () => {
  vi.spyOn(api, "worktrees").mockResolvedValue({ groups: [group("A", [worktree("clean", true, true), worktree("unknown", null)]), group("Z", [worktree("dirty", false)])] });
  mount(<WorktreePanel onNavigate={vi.fn()}/>);
  await screen.findByRole("row", { name: /dirty · 有修改/ });
  const rows = screen.getAllByRole("row").filter(row => row.hasAttribute("data-worktree"));
  expect(rows.map(r => r.getAttribute("data-state"))).toEqual(["dirty", "clean", "unknown"]);
  expect(screen.queryByLabelText("Worktree 详情")).toBeNull();
  const stats = screen.getByLabelText("Worktree 全局统计");
  expect(within(stats).getByRole("button", { name: "全部 Worktree 3" })).toBeTruthy();
  expect(within(stats).getByRole("button", { name: "有修改 1" })).toBeTruthy();
  expect(within(stats).getByRole("button", { name: "干净 1" })).toBeTruthy();
  expect(within(stats).getByRole("button", { name: "未知 1" })).toBeTruthy();
  expect(within(rows[1]).getByText("主工作区")).toBeTruthy();
  fireEvent.click(rows[0]);
  expect(screen.getByLabelText("Worktree 详情")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭 Worktree 详情" }));
  expect(screen.queryByLabelText("Worktree 详情")).toBeNull();
  fireEvent.change(screen.getByLabelText("Worktree 文件状态筛选"), { target: { value: "unknown" } });
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(within(stats).getByRole("button", { name: "全部 Worktree 3" })).toBeTruthy();
});

it("WT-11: groups by visible Git address while keeping independent bases, totals and scoped details", async () => {
  const sharedUrl = "git@example.com:team/shared.git";
  const first = group("clone-A", [worktree("clean-A", true, true), worktree("dirty-A", false)], sharedUrl);
  first.remote.remotes.push({ name: "upstream", fetchUrls: ["https://example.com/upstream.git"], pushUrls: ["https://push.example.com/upstream.git"] });
  vi.spyOn(api, "worktrees").mockResolvedValue({ groups: [first, group("clone-B", [worktree("clean-B", true, true)], sharedUrl), group("other", [worktree("unknown", null)])] });
  mount(<WorktreePanel onNavigate={vi.fn()}/>);
  const shared = await screen.findByRole("region", { name: `Git 地址：${sharedUrl}` });
  expect(screen.getAllByRole("region", { name: /^Git 地址：/ })).toHaveLength(2);
  expect(within(shared).getAllByRole("region", { name: /^本地 base：/ })).toHaveLength(2);
  expect(within(shared).getAllByRole("row").filter(row => row.hasAttribute("data-worktree")).map(row => row.getAttribute("data-worktree"))).toEqual(["dirty-A", "clean-A", "clean-B"]);
  expect(within(shared).getByText("2 个 base · 3 个 worktree · 修改 1 / 干净 2 / 未知 0")).toBeTruthy();
  expect(within(screen.getByLabelText("Worktree 全局统计")).getByRole("button", { name: "全部 Worktree 4" })).toBeTruthy();
  fireEvent.click(within(shared).getByText("其他 Git 地址 · 2 个"));
  expect(within(shared).getByText("https://push.example.com/upstream.git")).toBeTruthy();
  fireEvent.click(within(shared).getByRole("row", { name: /clean-B · 文件干净/ }));
  expect(within(screen.getByLabelText("Worktree 详情")).getByText("/clone-B/.git")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Worktree 文件状态筛选"), { target: { value: "unknown" } });
  expect(screen.queryByRole("region", { name: `Git 地址：${sharedUrl}` })).toBeNull();
  expect(within(screen.getByLabelText("Worktree 全局统计")).getByRole("button", { name: "全部 Worktree 4" })).toBeTruthy();
});

it("GG-07/08: fullscreen and Escape preserve pagination, selection and matching graph/list HEAD markers", async () => {
  const local = commit("a", "Local commit", true, false), remote = commit("b", "Remote commit", false, true);
  vi.spyOn(api, "graph").mockImplementation(async cursor => cursor ? page([remote], { total: 2 }) : page([local], { total: 2, nextCursor: 1 }));
  mount(<HistoryPanel repository={repository} onDiff={vi.fn()} onWorktree={vi.fn()}/>);
  await screen.findByText("Local commit");
  fireEvent.click(screen.getByRole("button", { name: "加载更多提交" }));
  await screen.findByText("Remote commit");
  fireEvent.click(screen.getByRole("button", { name: /Remote commit/ }));
  fireEvent.click(screen.getByRole("button", { name: "全屏查看 Git 历史" }));
  expect(screen.getByLabelText("Git 历史面板").classList.contains("history-fullscreen")).toBe(true);
  expect(document.querySelector(`[data-commit="${remote.hash}"]`)?.classList.contains("selected")).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByLabelText("Git 历史面板").classList.contains("history-fullscreen")).toBe(false);
  expect(screen.getByText("已加载 2 / 2 · 0 条待加载")).toBeTruthy();
  expect(document.querySelector(`[data-commit="${local.hash}"]`)?.classList.contains("local-head")).toBe(true);
  fireEvent.click(screen.getByTitle("线性列表"));
  const head = document.querySelector<HTMLElement>(`[data-commit="${local.hash}"]`)!;
  expect(within(head).getByText("当前本地 HEAD")).toBeTruthy();
  expect(within(head).getByText("本地独有")).toBeTruthy();
});

it("GG-08: locating an unloaded local HEAD switches to current history instead of selecting a remote tip", async () => {
  vi.spyOn(api, "graph").mockImplementation(async (_cursor, _repo, options) => options?.scope === "current" ? page([commit("a", "Current HEAD", true, false)], { scope: "current" }) : page([commit("b", "Remote tip", false, true)]));
  mount(<HistoryPanel repository={repository} onDiff={vi.fn()} onWorktree={vi.fn()}/>);
  await screen.findByText("Remote tip");
  fireEvent.click(screen.getByRole("button", { name: "定位" }));
  await screen.findByText("Current HEAD");
  await waitFor(() => expect((screen.getByLabelText("历史范围") as HTMLSelectElement).value).toBe("current"));
  expect(document.querySelector(`[data-commit="${repository.head}"]`)?.classList.contains("selected")).toBe(true);
});
