export type GitState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | null;
export type ChangeCategory = "conflicted" | "staged" | "unstaged" | "untracked";
export type DiffScope = "working" | "staged" | "all" | "commit";

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  openedAt: string;
  git: null | { repositoryRoot: string; branch: string | null; head: string | null; detached: boolean };
}

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  expandable: boolean;
  gitState: GitState;
  descendantChanged?: boolean;
}

export interface FileContent {
  path: string;
  content: string | null;
  encoding: "utf-8" | "unknown";
  lineEnding: "LF" | "CRLF" | "mixed" | "none";
  version: string;
  size: number;
  readOnly: boolean;
  binary: boolean;
  language?: string;
  finalNewline: boolean;
}

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  categories: ChangeCategory[];
  binary?: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitStatusSnapshot {
  revision: number;
  branch: string | null;
  head: string | null;
  detached: boolean;
  clean: boolean;
  files: GitChangedFile[];
  counts: Record<ChangeCategory, number>;
}

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
}

export interface GitCommitDetail extends GitCommitSummary {
  body: string;
  committerName: string;
  committerEmail: string;
  files: Array<{ path: string; oldPath?: string; status: string; additions?: number; deletions?: number }>;
  additions: number;
  deletions: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions?: number;
  deletions?: number;
  oldText?: string;
  newText?: string;
  truncated: boolean;
}

export interface DiffDocument {
  id: string;
  scope: DiffScope;
  base: string;
  target: string;
  generatedAt: string;
  gitRevision: number;
  truncated: boolean;
  files: DiffFile[];
}

export interface EventEnvelope {
  workspaceId: string;
  sequence: number;
  occurredAt: string;
  event: { type: string; path?: string; oldPath?: string; version?: string; revision?: number; head?: string | null };
}

export interface ApiErrorBody { error: { code: string; message: string; details?: unknown }; requestId: string }
