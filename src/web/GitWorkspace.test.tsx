// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DiffDocument, GitRepositoryInfo, GitStatusSnapshot } from "../shared/contracts";
import { ChangesWorkbench, GitWorkspace } from "./GitWorkspace";
import { api } from "./api";

vi.mock("./DiffViewer", () => ({ DiffViewer: ({ original, modified }: { original: string; modified: string }) => <div data-testid="diff-content">{original} → {modified}</div> }));
const repository: GitRepositoryInfo = { id: "repo", repositoryGroupId: "group", worktreeId: "main", commonDir: "/repo/.git", name: "repo", workspacePath: "repo", repositoryRoot: "/repo", branch: "main", head: "a".repeat(40), detached: false, current: true, discoveryDepth: 1 };
const snapshot: GitStatusSnapshot = { repositoryId: "repo", revision: 1, branch: "main", head: repository.head, detached: false, clean: false, files: [
  { path: "src/shared.ts", indexStatus: "M", worktreeStatus: "M", categories: ["staged", "unstaged"] },
  { path: "notes.md", indexStatus: "?", worktreeStatus: "?", categories: ["untracked"] }
], counts: { conflicted: 0, staged: 1, unstaged: 1, untracked: 1 } };
const diff = (scope: string, path = "src/shared.ts"): DiffDocument => ({ id: `${scope}:${path}`, scope: scope as DiffDocument["scope"], base: scope === "staged" ? "HEAD" : "INDEX", target: scope === "staged" ? "INDEX" : "WORKTREE", generatedAt: "2026-10-29T00:00:00Z", gitRevision: 1, truncated: false, files: [{ path, status: "modified", oldText: `${scope} original`, newText: `${scope} modified`, truncated: false }] });
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } } });
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.spyOn(api, "gitStatus").mockResolvedValue(snapshot);
  vi.spyOn(api, "diff").mockImplementation(async (scope, path) => diff(scope, path));
  vi.spyOn(api, "sync").mockResolvedValue(null);
  vi.spyOn(api, "refs").mockResolvedValue([]);
  vi.spyOn(api, "graph").mockResolvedValue({ items: [], nextCursor: null, head: repository.head, graphRevision: "v1", scope: "all", total: 0, shallow: false, comparison: { upstream: null, ahead: null, behind: null } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("compares the index and working copy independently when a file occurs in both categories", async () => {
  render(<ChangesWorkbench repository={repository} onHistory={vi.fn()}/>, { wrapper: provider() });
  await screen.findByText("staged original → staged modified");
  const list = screen.getByLabelText("修改文件");
  const copies = within(list).getAllByRole("button", { name: /shared.ts/ });
  expect(copies).toHaveLength(2);
  fireEvent.click(copies[1]);
  await screen.findByText("working original → working modified");
  expect(api.diff).toHaveBeenLastCalledWith("working", "src/shared.ts", "repo");
  expect(copies[0].getAttribute("aria-pressed")).toBe("false");
  expect(copies[1].getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(list).getByRole("button", { name: /notes.md/ }));
  await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith("working", "notes.md", "repo"));
});

it("retains file selection across Git tabs and module visibility without fetching hidden diffs", async () => {
  const wrapper = provider();
  const props = { repository, tab: "changes" as const, onTab: vi.fn(), onWorktree: vi.fn(), branchPicker: null };
  const view = render(<GitWorkspace {...props} active/>, { wrapper });
  const notes = await screen.findByRole("button", { name: /notes.md/ });
  fireEvent.click(notes);
  await waitFor(() => expect(api.diff).toHaveBeenLastCalledWith("working", "notes.md", "repo"));
  view.rerender(<GitWorkspace {...props} active={false}/>);
  view.rerender(<GitWorkspace {...props} active/>);
  expect(screen.getByRole("button", { name: /notes.md/ }).getAttribute("aria-pressed")).toBe("true");
  expect(api.graph).not.toHaveBeenCalled();
});

it("keeps failed and empty file states explicit instead of displaying another file's diff", async () => {
  vi.mocked(api.gitStatus).mockResolvedValue({ ...snapshot, clean: true, files: [] });
  const onHistory = vi.fn();
  render(<ChangesWorkbench repository={repository} onHistory={onHistory}/>, { wrapper: provider() });
  await screen.findByText("工作目录干净");
  expect(screen.queryByLabelText("文件差异")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看提交历史" }));
  expect(onHistory).toHaveBeenCalledOnce();
});

it("fetches only the selected local repository group and invalidates the displayed data", async () => {
  vi.spyOn(api, "fetch").mockResolvedValue({ repositoryGroupId: "group", startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", remotes: [] });
  render(<GitWorkspace repository={repository} tab="changes" onTab={vi.fn()} onWorktree={vi.fn()} branchPicker={null} active/>, { wrapper: provider() });
  fireEvent.click(screen.getByRole("button", { name: "获取远程" }));
  await waitFor(() => expect(api.fetch).toHaveBeenCalledExactlyOnceWith("group"));
  await waitFor(() => expect(screen.getByRole("button", { name: "获取远程" }).hasAttribute("disabled")).toBe(false));
});
