import type { ApiErrorBody, DiffDocument, FileContent, FileTreeEntry, GitCommitDetail, GitCommitSummary, GitStatusSnapshot, WorkspaceInfo } from "../shared/contracts";

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as ApiErrorBody | null;
    throw new ApiClientError(response.status, error?.error.code ?? "REQUEST_FAILED", error?.error.message ?? "请求失败", error?.error.details);
  }
  return body.data as T;
}

export const api = {
  workspace: () => request<WorkspaceInfo>("/api/workspace"),
  openWorkspace: (path: string) => request<WorkspaceInfo>("/api/workspace/open", { method: "POST", body: JSON.stringify({ path }) }),
  closeWorkspace: () => request<null>("/api/workspace/close", { method: "POST" }),
  tree: (path = "") => request<FileTreeEntry[]>(`/api/files/tree?path=${encodeURIComponent(path)}`),
  file: (path: string) => request<FileContent>(`/api/files/content?path=${encodeURIComponent(path)}`),
  save: (path: string, content: string, expectedVersion: string) => request<FileContent>("/api/files/content", { method: "PUT", body: JSON.stringify({ path, content, expectedVersion }) }),
  createFile: (path: string) => request<FileContent>("/api/files", { method: "POST", body: JSON.stringify({ path }) }),
  createDirectory: (path: string) => request<null>("/api/directories", { method: "POST", body: JSON.stringify({ path }) }),
  rename: (from: string, to: string) => request<null>("/api/files/rename", { method: "PATCH", body: JSON.stringify({ from, to }) }),
  remove: (path: string, recursive = false) => request<null>(`/api/files?path=${encodeURIComponent(path)}&recursive=${recursive}&confirmed=true`, { method: "DELETE" }),
  gitStatus: () => request<GitStatusSnapshot>("/api/git/status"),
  history: (cursor?: string) => request<{ items: GitCommitSummary[]; nextCursor: string | null; head: string | null }>(`/api/git/history?limit=50${cursor ? `&cursor=${cursor}` : ""}`),
  commit: (hash: string) => request<GitCommitDetail>(`/api/git/commits/${hash}`),
  diff: (scope: "working" | "staged" | "all", path?: string) => request<DiffDocument>(`/api/git/diff?scope=${scope}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
  commitDiff: (hash: string, path?: string) => request<DiffDocument>(`/api/git/diff/commits/${hash}${path ? `?path=${encodeURIComponent(path)}` : ""}`)
};
