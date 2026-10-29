export type GitState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | null;
export type ChangeCategory = "conflicted" | "staged" | "unstaged" | "untracked";
export type DiffScope = "working" | "staged" | "all" | "commit";

export interface GitRepositoryInfo {
  id: string;
  repositoryGroupId: string;
  worktreeId: string;
  commonDir: string;
  name: string;
  workspacePath: string;
  workspacePaths?: string[];
  repositoryRoot: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  current: boolean;
  discoveryDepth: number;
  changedFileCount?: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  openedAt: string;
  git: null | GitRepositoryInfo;
  repositories: GitRepositoryInfo[];
  repositoryGroups?: GitRepositoryGroup[];
  repositoryDiscovery: { depth: number; maxDirs: number; timedOut: boolean; truncated: boolean; checkedDirs: number };
  changedRepositoryCount?: number;
  changedFileCount?: number;
  initialization?: {
    id: string;
    status: "loading" | "ready" | "error";
    phase: "discovery" | "groups" | "status" | "watching";
    error?: string;
  };
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
  gitTrackedState?: "tracked" | "untracked" | "uncontrolled" | "repository";
  repositoryId?: string;
  repositoryPath?: string;
  repositoryName?: string;
  repositoryChangedFileCount?: number;
}

export interface WorkspaceChangeSummary {
  path: string;
  name: string;
  repositoryCount: number;
  changedRepositoryCount: number;
  changedFileCount: number;
  error?: string;
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
  repositoryId: string;
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

export interface GitBranchInfo {
  name: string;
  fullName: string;
  kind: "local" | "remote";
  current: boolean;
  target: string;
  upstream?: string;
}

export interface GitGraphCommit extends GitCommitSummary {
  decorations: Array<{ type: "head" | "local" | "remote" | "tag" | "worktree" | "other"; name: string; worktreeId?: string }>;
  inCurrentHistory: boolean | null;
  inRemoteHistory: boolean | null;
}

export type HistoryScope = "all" | "current" | "ref";
export interface GitHistoryPage {
  items: GitGraphCommit[];
  nextCursor: number | null;
  head: string | null;
  graphRevision: string;
  scope: HistoryScope;
  total: number;
  shallow: boolean;
  comparison: { upstream: string | null; ahead: number | null; behind: number | null };
}
export interface RemoteSyncResult { name: string; success: boolean; finishedAt: string; lastSuccessAt?: string; error?: string }
export interface GitFetchResult { repositoryGroupId: string; startedAt: string; finishedAt: string; remotes: RemoteSyncResult[] }
export interface GitWorktree {
  worktreeId: string;
  repositoryGroupId: string;
  repositoryId?: string;
  path: string;
  workspacePath?: string;
  head: string | null;
  branch: string | null;
  main: boolean | null;
  current: boolean;
  inWorkspace: boolean;
  missing: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
  gitDir?: string;
}
export interface GitRepositoryGroup {
  repositoryGroupId: string;
  commonDir: string;
  name: string;
  worktrees: GitWorktree[];
  truncated: boolean;
  error?: string;
}
export interface WorktreeStatus extends GitWorktree {
  readAt: string;
  status: GitStatusSnapshot | null;
  error?: string;
  upstream: { ref: string; ahead: number; behind: number } | null;
  unpublished: number | null;
  defaultBranch: string | null;
  defaultRelation: "equal" | "ancestor" | "descendant" | "diverged" | "unknown";
  syncNote: string;
}
export interface WorktreeOverview {
  groups: Array<Omit<GitRepositoryGroup, "worktrees"> & { worktrees: WorktreeStatus[]; changedFileCount: number; unknownCount: number; sync?: GitFetchResult; remote: GitRemoteAddresses }>;
}
export interface GitRemoteAddresses {
  primaryName: string | null;
  primaryUrl: string | null;
  remotes: Array<{ name: string; fetchUrls: string[]; pushUrls: string[] }>;
  error?: string;
}
export interface RemovalPreview {
  worktree: WorktreeStatus;
  token: string;
  allowed: boolean;
  reasons: string[];
  warnings: string[];
  ignoredCount: number | null;
  unsavedCount: number;
  otherSessionCount: number;
  branchPreserved: string | null;
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
  binary?: boolean;
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
