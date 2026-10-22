# 轻量级代码工作区详细设计文档

## 1. 文档信息

- 产品代号：Code Workspace
- 文档版本：V1.0
- 设计基线：文件树、Monaco 编辑、Git 历史、Git Diff、外部文件变化同步
- 部署形态：本地或受信任内网中的单用户 Web 应用
- 设计日期：2026-07-19
- 扩展修订：2026-10-22；B-009/B-010 的实现设计见[第 21 节](#21-远程提交图与-worktree-设计扩展)。MVP 及 V1.1 内容保留其历史基线，阶段 A 已实现，阶段 B 的实际移除尚未实施。

## 2. 设计目标与边界

### 2.1 设计目标

系统提供一个轻量、可靠的代码工作区，完成以下闭环：

```text
打开本地目录
  → 浏览目录和文件状态
  → 查看、编辑并保存文本文件
  → 感知其他程序对工作区的修改
  → 查看 Git 工作区状态和不同范围的 Diff
  → 浏览提交历史及提交 Diff
```

设计重点：

- 文件树在大型仓库下仍能按需加载。
- Monaco 未保存内容不会被磁盘变化静默覆盖。
- Git HEAD、暂存区、磁盘和编辑器缓冲区四层状态边界清晰。
- 外部程序修改文件后，界面能在目标时间内同步。
- Git、文件监听等子系统失败时，不影响未保存的编辑内容。
- 所有后端文件访问都限制在当前工作区内。

### 2.2 明确不包含

本系统不包含：

- Codex 会话、聊天、任务、运行日志或终端。
- xterm.js、PTY 服务或任意命令执行入口。
- AI Commit、AI Diff 或 AI 审查。
- Git Commit、Stage、Unstage、Discard、Push、Pull 等写操作；V1.1 纳入受控分支切换。后续受控 fetch 及 worktree 移除的阶段边界见第 21 节，不表示当前已实现。
- 调试器、插件系统、完整语言服务器、多用户协作。
- 多工作区同时打开。

外部 Codex、终端、格式化器或代码生成器仅被视为“外部文件修改者”，系统不识别也不管理其会话。

## 3. 关键设计决策

| 编号 | 决策 | 说明 |
|---|---|---|
| ADR-01 | 前后端分离的本地 Web 架构 | 浏览器负责交互，Node.js 负责文件系统与 Git 访问 |
| ADR-02 | 单进程、单活动工作区 | 降低 MVP 的状态隔离和资源管理复杂度 |
| ADR-03 | Git 使用系统 Git CLI | 对仓库特性、重命名、合并提交和配置兼容性更好 |
| ADR-04 | 文件树按目录懒加载 | 不对大型仓库做全量递归扫描 |
| ADR-05 | 文件版本采用内容摘要结合元数据 | 保存时执行乐观并发控制，避免静默覆盖 |
| ADR-06 | WebSocket 推送工作区事件 | 统一承载文件和 Git 状态变化通知 |
| ADR-07 | 前端不自行推断 Git 状态 | Git 语义统一由后端解析并输出结构化模型 |
| ADR-08 | MVP Git 功能只读 | 降低误操作和仓库损坏风险 |

## 4. 总体架构

```text
┌──────────────────────── Browser ────────────────────────┐
│ React Shell                                              │
│ ├── Workspace Header                                     │
│ ├── File Explorer                                        │
│ ├── Git Changes                                          │
│ ├── Git History                                          │
│ ├── Monaco Text Editor                                   │
│ ├── Monaco Diff Editor                                   │
│ └── Client State / WebSocket Client                      │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP JSON + WebSocket
┌───────────────────────▼──────────────────────────────────┐
│ Node.js Application                                      │
│ ├── WorkspaceController / WorkspaceService               │
│ ├── FileController / FileService                         │
│ ├── GitController / GitService                           │
│ ├── WatchService / EventHub                              │
│ ├── PathGuard / FileClassifier                           │
│ └── Error Mapper / Observability                         │
└──────────────┬───────────────────────┬────────────────────┘
               │                       │
       Node fs / chokidar         Git CLI subprocess
               │                       │
┌──────────────▼───────────────────────▼────────────────────┐
│ Local Workspace / Git Repository                         │
└───────────────────────────────────────────────────────────┘
```

### 4.1 推荐技术栈

后端：

- Node.js 22 LTS
- TypeScript
- Fastify
- TypeBox 或 Zod：API 输入输出校验
- chokidar：跨平台文件监听
- `node:child_process.spawn`：执行 Git CLI
- `node:crypto`：生成文件内容摘要
- WebSocket：实时事件

前端：

- React 19
- TypeScript
- Vite
- Monaco Editor
- React Router
- Zustand：工作区、标签页和视图状态
- TanStack Query：服务端数据缓存和失效刷新
- Vitest、Testing Library、Playwright

### 4.2 进程和并发模型

- 单个 Node.js 进程服务一个活动工作区。
- 文件读取、摘要计算和 Git 命令均采用异步接口。
- Git 查询通过限流队列执行，默认最大并发 2。
- 同一类高频刷新请求合并，避免文件事件风暴触发大量 Git 进程。
- 保存操作按文件路径串行化，避免同一文件并发写入。
- 浏览器断开不会删除未保存内容；未保存内容主要保存在浏览器内存，并可选写入 `sessionStorage` 做崩溃恢复。

## 5. 建议目录结构

```text
code-workspace/
├── docs/
│   ├── detailed-design.md
│   └── task-plan.md
├── package.json
├── tsconfig.base.json
├── apps/
│   ├── server/
│   │   └── src/
│   │       ├── app.ts
│   │       ├── config.ts
│   │       ├── routes/
│   │       │   ├── workspace.routes.ts
│   │       │   ├── files.routes.ts
│   │       │   └── git.routes.ts
│   │       ├── services/
│   │       │   ├── WorkspaceService.ts
│   │       │   ├── FileService.ts
│   │       │   ├── GitService.ts
│   │       │   ├── WatchService.ts
│   │       │   └── EventHub.ts
│   │       ├── security/
│   │       │   └── PathGuard.ts
│   │       └── infrastructure/
│   │           ├── GitRunner.ts
│   │           └── AtomicFileWriter.ts
│   └── web/
│       └── src/
│           ├── app/
│           ├── pages/
│           ├── features/
│           │   ├── workspace/
│           │   ├── explorer/
│           │   ├── editor/
│           │   ├── git-changes/
│           │   └── git-history/
│           ├── components/
│           ├── stores/
│           └── api/
├── packages/
│   └── shared/
│       └── src/
│           ├── contracts.ts
│           ├── events.ts
│           └── errors.ts
└── tests/
    ├── fixtures/
    ├── integration/
    └── e2e/
```

## 6. 核心领域模型

### 6.1 工作区模型

```ts
interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  openedAt: string;
  git: null | {
    repositoryRoot: string;
    branch: string | null;
    head: string | null;
    detached: boolean;
  };
}
```

`id` 根据规范化后的根路径生成稳定摘要，不直接作为路径使用。

### 6.2 文件树模型

```ts
type EntryKind = "file" | "directory" | "symlink";
type GitFileState = "modified" | "added" | "deleted" | "renamed" |
  "untracked" | "conflicted" | "ignored" | null;

interface FileTreeEntry {
  name: string;
  path: string;              // 相对工作区的 POSIX 风格路径
  kind: EntryKind;
  size?: number;
  modifiedAt?: string;
  hidden: boolean;
  expandable: boolean;
  gitState: GitFileState;
  descendantChanged?: boolean;
}
```

API 中不向前端返回可拼接使用的真实绝对路径；“复制绝对路径”通过受控接口获取。

### 6.3 文件内容和版本模型

```ts
interface FileContent {
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
```

版本格式：

```text
v1:<size>:<mtimeNs>:<sha256>
```

- `size + mtime` 用于快速判断可能变化。
- SHA-256 用于保存前的最终一致性判断。
- 版本仅代表磁盘内容，不代表 Git blob。

### 6.4 Git 状态模型

```ts
interface GitStatusSnapshot {
  revision: number;
  branch: string | null;
  head: string | null;
  detached: boolean;
  clean: boolean;
  files: GitChangedFile[];
  counts: {
    conflicted: number;
    staged: number;
    unstaged: number;
    untracked: number;
  };
}

interface GitChangedFile {
  path: string;
  oldPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  category: "conflicted" | "staged" | "unstaged" | "untracked";
  binary?: boolean;
  additions?: number;
  deletions?: number;
}
```

同一文件可能同时出现在 staged 和 unstaged 分类中，前端不能按路径简单去重。

### 6.5 Git 历史模型

```ts
interface GitCommitSummary {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail?: string;
  authoredAt: string;
  committedAt: string;
}

interface GitCommitDetail extends GitCommitSummary {
  body: string;
  committerName: string;
  committerEmail?: string;
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}
```

### 6.6 Diff 模型

```ts
type DiffScope = "working" | "staged" | "all" | "commit";

interface DiffDocument {
  id: string;
  scope: DiffScope;
  base: DiffRevision;
  target: DiffRevision;
  generatedAt: string;
  truncated: boolean;
  files: DiffFile[];
}

interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions?: number;
  deletions?: number;
  oldText?: string;
  newText?: string;
  oldLanguage?: string;
  newLanguage?: string;
  truncated: boolean;
}
```

Monaco Diff Editor 需要完整的左右文本，因此后端不只返回 patch。超限时返回元数据和截断状态，由用户按单文件继续加载。

## 7. 后端详细设计

### 7.1 WorkspaceService

职责：

- 打开、查询和关闭当前工作区。
- 规范化并持有唯一工作区根路径。
- 检测 Git 仓库及仓库根目录。
- 协调 WatchService 和 GitService 生命周期。
- 切换前检查前端声明的未保存标签；最终确认由前端完成。

打开流程：

```text
接收目录路径
  → realpath 解析真实路径
  → 验证存在、可读且为目录
  → 建立工作区上下文
  → git rev-parse 检测仓库
  → 启动 WatchService
  → 生成初始 Git 状态
  → 返回 WorkspaceInfo
```

限制：MVP 仅允许一个活动上下文。再次打开目录会关闭旧监听器并清空服务端缓存。

### 7.2 PathGuard

所有文件 API 必须先经过 PathGuard：

1. 拒绝绝对路径输入，API 仅接收相对路径。
2. 将分隔符标准化，拒绝 NUL 字符和非法编码。
3. 使用工作区根路径拼接并执行 `realpath` 或父目录 `realpath`。
4. 验证结果等于根路径或位于根路径之下。
5. 拒绝访问 `.git` 目录及其后代。
6. 默认拒绝跟随指向工作区外部的符号链接。
7. 对新建目标验证最近存在父目录的真实路径。

不能只使用字符串前缀判断。例如 `/workspace-a` 不是 `/workspace` 的子目录。

### 7.3 FileService

职责：

- 列出指定目录的直接子节点。
- 读取、分类和保存文件。
- 新建、重命名和删除文件或目录。
- 提供受控的绝对路径复制信息。
- 维护短生命周期文件元数据缓存。

#### 7.3.1 目录读取

- 使用 `fs.readdir({ withFileTypes: true })`。
- 不递归读取。
- `.git` 永久过滤。
- 隐藏文件和 Git ignored 文件根据查询设置过滤。
- 返回前进行自然排序：目录优先，其次文件。
- 单目录节点数超过配置阈值时分页返回。

#### 7.3.2 文本和二进制检测

读取前先获取 `stat`，然后读取最多前 8 KiB：

- 包含 NUL 字节时视为二进制。
- 无 NUL 但 UTF-8 解码失败时编码为 `unknown`，默认只读。
- 文件扩展名只作为语言模式提示，不能替代二进制检测。
- 超过软限制返回警告，超过硬限制默认不返回完整内容。

默认限制：

```text
FILE_WARN_BYTES=2 MiB
FILE_READONLY_BYTES=10 MiB
REQUEST_BODY_MAX_BYTES=12 MiB
```

#### 7.3.3 保存流程

```text
校验路径和请求大小
  → 对目标路径加互斥锁
  → 读取当前磁盘版本
  → 与 expectedVersion 比较
  → 不一致则返回 409 和当前版本元数据
  → 写入同目录临时文件
  → fsync（可配置）
  → 原子 rename 替换目标文件
  → 保留原有权限位
  → 计算并返回新版本
```

保存内容由前端按原始换行符准备；后端不得做隐式格式化或换行转换。

#### 7.3.4 文件操作

- 新建：目标必须不存在，冲突返回 `409 PATH_EXISTS`。
- 重命名：源必须存在、目标必须不存在，并验证两端路径。
- 删除：后端要求 `confirmed=true`；非空目录需单独声明递归删除。
- 所有成功操作都会产生工作区事件，但前端应按事件 ID 去重。

### 7.4 GitRunner

GitRunner 是唯一允许启动 Git 子进程的模块：

- 使用 `spawn(gitPath, args, { cwd: repositoryRoot, shell: false })`。
- 不接收前端传入的任意参数数组。
- 为每类操作构造固定命令及经过校验的 ref/path 参数。
- 默认超时 10 秒，历史大查询可配置为 30 秒。
- stdout/stderr 分别限制大小，超限终止进程并返回结构化错误。
- 设置 `GIT_OPTIONAL_LOCKS=0`，避免只读查询写锁。
- 设置稳定 locale，优先使用机器可解析输出。
- 参数涉及路径时使用 `--` 分隔 revision 与 pathspec。

### 7.5 GitService

#### 7.5.1 仓库检测

使用：

```text
git rev-parse --show-toplevel
git rev-parse --is-inside-work-tree
git symbolic-ref --short -q HEAD
git rev-parse --verify HEAD
```

空仓库允许 `HEAD` 不存在，此时历史为空，未跟踪文件仍可显示。

#### 7.5.2 状态解析

使用 porcelain v2 和 NUL 分隔输出：

```text
git status --porcelain=v2 -z --branch --untracked-files=all
```

避免使用面向人的本地化输出。解析普通、重命名、未跟踪和冲突记录，生成 `GitStatusSnapshot`。

新增/删除统计按需计算，不在每次文件事件后全仓库强制计算；修改列表首次展示或明确刷新时执行 numstat 查询。

#### 7.5.3 历史读取

历史采用游标分页：

- `limit` 默认 50，最大 100。
- 首次以当前 HEAD 为起点。
- 下一页游标是上一页最后一条提交的完整 hash。
- 查询使用稳定字段分隔符和 NUL 记录分隔符。
- 提交详情单独加载，不随列表返回完整文件和正文。

当历史在分页过程中变化时，接口返回当前 `head`。前端发现 head 不一致，应提示并从第一页重新加载。

#### 7.5.4 Diff 语义

| Scope | Git 语义 | 说明 |
|---|---|---|
| `working` | 暂存区 → 工作区 | 未暂存修改 |
| `staged` | HEAD → 暂存区 | 已暂存修改；空仓库以空树为基线 |
| `all` | HEAD → 工作区 | 已跟踪文件全部未提交修改，并额外纳入未跟踪文件 |
| `commit` | 第一父提交 → 指定提交 | 根提交以 Git 空树为父基线 |

实现要求：

- 路径、状态和 numstat 使用 Git 原生 NUL 分隔格式解析。
- 左右文本优先通过 `git show <revision>:<path>` 读取。
- 工作区侧从磁盘读取；暂存区侧从 `:<path>` 读取。
- 未跟踪文件在 `all`/`working` 中作为新增文件处理。
- Merge Commit 默认与第一父提交比较，详情中显式返回比较基线。
- 二进制文件只返回元数据。
- 单文件内容与整次 Diff 都有大小限制。

#### 7.5.5 缓存与失效

- Git 状态缓存有效期建议 300 ms。
- 历史第一页可缓存 2 秒，提交详情按 hash 长期缓存。
- `.git/index`、`.git/HEAD`、`.git/refs` 或工作区内容变化时，使相关缓存失效。
- 由于 `.git` 不对文件树开放，WatchService 仍需在内部监听必要 Git 元数据。

### 7.6 WatchService

#### 7.6.1 监听策略

使用 chokidar 监听工作区，关注：

- `add`、`change`、`unlink`
- `addDir`、`unlinkDir`
- 必要的 `.git/HEAD`、`.git/index`、`.git/refs/**`

默认忽略：

- `.git/objects/**`、`.git/logs/**`
- `node_modules/**`
- 常见构建输出目录和编辑器临时文件
- 可配置忽略规则

`.gitignore` 不应自动等同于监听忽略，因为用户可能选择展示 ignored 文件；两者分别配置。

#### 7.6.2 事件归并

- 同一路径 100 ms 内的连续 change 合并为一个事件。
- unlink 后短时间出现同目录 add，可在 inode/时间信息足够时推断 rename；否则发送 delete + create。
- 一批事件在 250 ms 防抖后触发一次 Git 状态刷新。
- 每个事件带单调递增序号 `sequence`。

#### 7.6.3 服务端事件

```ts
type WorkspaceEvent =
  | { type: "file.created"; path: string; version?: string }
  | { type: "file.changed"; path: string; version?: string }
  | { type: "file.deleted"; path: string }
  | { type: "file.renamed"; oldPath: string; path: string }
  | { type: "directory.created"; path: string }
  | { type: "directory.deleted"; path: string }
  | { type: "git.statusChanged"; revision: number }
  | { type: "git.headChanged"; head: string | null };
```

实际传输包装：

```ts
interface EventEnvelope {
  workspaceId: string;
  sequence: number;
  occurredAt: string;
  event: WorkspaceEvent;
}
```

### 7.7 EventHub 与 WebSocket

- 连接建立后验证当前 workspace ID。
- 服务端保留最近 500 条事件或最近 60 秒事件。
- 客户端重连时携带 `lastSequence`，服务端尽量补发。
- 无法补发时发送 `workspace.resyncRequired`，客户端重新获取工作区、展开目录、Git 状态以及已打开文件版本。
- 使用 ping/pong 检测死连接。
- 事件仅作为失效通知；关键状态应通过 HTTP 重新读取，避免将 WebSocket 作为唯一事实来源。

## 8. 前端详细设计

### 8.1 页面布局

```text
AppShell
├── TopBar
│   ├── WorkspaceName
│   ├── BranchBadge
│   └── RefreshAction
├── ActivityBar
│   ├── ExplorerAction
│   ├── GitChangesAction
│   └── GitHistoryAction
├── SidePanel
│   ├── FileExplorer
│   ├── GitChangesPanel
│   └── GitHistoryPanel
├── EditorArea
│   ├── EditorTabs
│   ├── TextEditorPane
│   ├── GitDiffPane
│   └── ConflictDiffPane
└── StatusBar
```

### 8.2 状态划分

Zustand 本地状态：

- 当前工作区摘要。
- 文件树节点、展开状态和选择状态。
- 编辑器标签页、缓冲区、光标位置和 dirty 状态。
- 活动侧栏和布局设置。
- WebSocket 连接和最后事件序号。

TanStack Query 服务端状态：

- 目录节点查询。
- 文件磁盘内容。
- Git 状态。
- Git 历史分页和提交详情。
- Diff 文档。

原则：编辑器未保存缓冲区不能存进 Query cache，避免刷新服务端数据时覆盖用户输入。

### 8.3 标签页模型

```ts
type EditorTab = TextFileTab | GitDiffTab | ConflictDiffTab;

interface TextFileTab {
  id: string;
  type: "text";
  path: string;
  diskVersion: string;
  savedText: string;
  bufferText: string;
  dirty: boolean;
  externalState: "current" | "changed" | "deleted";
}
```

`dirty` 通过 `bufferText !== savedText` 判断。`savedText` 是最后一次确认的磁盘内容，不等同于 Git HEAD。

### 8.4 打开文件流程

```text
点击文件
  → 已有标签则激活
  → 请求文件内容
  → 二进制/超限时显示专用提示页
  → 创建 Monaco model（URI 基于 workspaceId + 相对路径）
  → 记录磁盘 version、savedText 和 bufferText
  → 恢复光标和滚动位置
```

Monaco model 生命周期与标签页绑定；关闭最后一个引用标签时释放 model，避免长期占用内存。

### 8.5 保存和冲突流程

正常保存：

```text
Ctrl/Cmd+S
  → PUT content + expectedVersion
  → 成功：更新 savedText、diskVersion、dirty=false
  → 等待或吸收对应 watcher 事件
```

冲突保存：

```text
PUT 返回 409
  → 保留 bufferText
  → 获取最新磁盘内容
  → externalState=changed
  → 打开 ConflictDiffPane
```

冲突操作：

- 使用磁盘版本：替换 `savedText`、`bufferText` 和 `diskVersion`。
- 保留编辑器版本：以最新磁盘版本作为新的 expectedVersion，再次确认后覆盖保存。
- 手动合并：在可编辑合并区修改，最终仍走版本校验保存。
- 暂不处理：保留标签冲突标识，禁止普通保存静默继续。

### 8.6 外部事件处理矩阵

| 事件 | 标签未打开 | 已打开且 clean | 已打开且 dirty |
|---|---|---|---|
| changed | 失效目录/Git 查询 | 重新读取并更新 model | 保留 buffer，标记 changed |
| deleted | 更新文件树 | 保留 model，标记 deleted | 保留 buffer，标记 deleted |
| renamed | 更新文件树 | 更新标签路径并校验内容 | 提示用户确认新路径，保留 buffer |
| created | 更新父目录 | 不适用 | 不适用 |

自动更新 clean 标签时，应通过 Monaco 编辑操作更新内容，尽量保持光标和滚动位置，而不是销毁 model。

### 8.7 文件树交互

- 展开目录时调用目录 API，结果按 path 缓存。
- 文件事件只失效受影响的父目录。
- Git 状态变化后将文件状态映射到已加载节点，并向祖先传播聚合标识。
- 重命名和删除前由前端弹出确认；后端仍执行存在性与冲突校验。
- 当前文件在树中可见时高亮；“在文件树中定位”逐级加载父目录。

### 8.8 Git 修改视图

分组顺序：

1. 冲突
2. 已暂存
3. 未暂存
4. 未跟踪

点击不同分组中的同一路径时，使用对应 Diff scope：

- 已暂存 → `staged`
- 未暂存 → `working`
- 未跟踪 → `working`，左侧为空
- 冲突 → MVP 显示冲突状态和工作树文件；三方合并视图不在范围内

顶部提供“全部修改”入口，对应 `all`。

### 8.9 Git 历史视图

- 使用无限滚动或“加载更多”，每页 50 条。
- 列表项显示短 hash、主题、作者、相对/绝对时间和 merge 标识。
- 点击提交先加载详情，再显示文件列表。
- 点击文件打开 `commit` scope Diff。
- 当 HEAD 变化时，在列表顶部显示“历史已更新，点击刷新”，不强行跳动当前阅读位置。

### 8.10 Diff Editor

- 默认并排模式，窄屏自动使用行内模式。
- 左右 Monaco model 使用只读 URI，包含 revision 和 path，避免与工作区编辑 model 混用。
- 切换文件时释放不再使用的大型 Diff model。
- 标题明确展示：`HEAD → 工作区`、`HEAD → 暂存区`、`暂存区 → 工作区` 或 `<parent> → <commit>`。
- Diff 过期时显示遮罩提示，用户刷新后才清除。
- 二进制或截断文件显示专用占位页，不能显示不完整内容却不作标识。

### 8.11 浏览器状态恢复

可在 `sessionStorage` 保存：

- 工作区 ID。
- 已打开文件路径。
- 活动标签。
- 光标和滚动位置。
- dirty 文件的临时缓冲区及对应磁盘版本。

恢复时必须重新查询磁盘版本；若版本变化，直接进入外部修改冲突状态。

## 9. API 设计

统一响应：

```ts
interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}
```

### 9.1 工作区 API

#### `POST /api/workspace/open`

请求：

```json
{ "path": "/absolute/local/path" }
```

响应：`WorkspaceInfo`。

#### `GET /api/workspace`

返回当前工作区；未打开时返回 `404 WORKSPACE_NOT_OPEN`。

#### `POST /api/workspace/close`

关闭服务端工作区上下文。前端需在调用前处理 dirty 标签。

### 9.2 文件 API

#### `GET /api/files/tree`

参数：

- `path`：相对目录，根目录为空字符串。
- `showHidden`：默认 `true`。
- `showIgnored`：默认 `false`。
- `cursor`、`limit`：超大目录分页。

#### `GET /api/files/content`

参数：`path`。

响应：`FileContent`。

#### `PUT /api/files/content`

```json
{
  "path": "src/app.ts",
  "content": "...",
  "expectedVersion": "v1:..."
}
```

成功返回新 `FileContent` 元数据；版本不一致返回 `409 FILE_VERSION_CONFLICT`。

#### 文件操作

```text
POST   /api/files
POST   /api/directories
PATCH  /api/files/rename
DELETE /api/files
GET    /api/files/absolute-path?path=
```

### 9.3 Git API

```text
GET /api/git/repository
GET /api/git/status?includeStats=false
GET /api/git/history?cursor=&limit=50
GET /api/git/commits/:hash
GET /api/git/diff?scope=working|staged|all&path=
GET /api/git/diff/commits/:hash?path=
```

Ref 参数只允许符合 Git object ID 的完整/短 hash，或由服务端内部解析的 HEAD，不接受任意 revision expression。

### 9.4 WebSocket

```text
GET /api/events?workspaceId=<id>&lastSequence=<n>
```

连接成功后服务端发送：

```json
{
  "type": "connected",
  "workspaceId": "...",
  "currentSequence": 1042
}
```

## 10. 错误码

| HTTP | 错误码 | 场景 |
|---|---|---|
| 400 | `INVALID_PATH` | 路径格式非法 |
| 400 | `INVALID_REQUEST` | 参数校验失败 |
| 403 | `PATH_OUTSIDE_WORKSPACE` | 目标逃出工作区 |
| 403 | `GIT_INTERNAL_PATH_DENIED` | 访问 `.git` |
| 404 | `WORKSPACE_NOT_OPEN` | 尚未打开工作区 |
| 404 | `PATH_NOT_FOUND` | 文件或目录不存在 |
| 409 | `PATH_EXISTS` | 新建或重命名目标已存在 |
| 409 | `FILE_VERSION_CONFLICT` | 保存时磁盘版本变化 |
| 413 | `FILE_TOO_LARGE` | 文件或响应超过限制 |
| 415 | `BINARY_FILE` | 文本接口读取二进制文件 |
| 422 | `UNSUPPORTED_ENCODING` | 编码不能安全编辑 |
| 503 | `GIT_UNAVAILABLE` | Git 不存在或仓库不可用 |
| 504 | `GIT_TIMEOUT` | Git 查询超时 |

错误消息用于用户理解，错误码用于前端稳定分支处理。

## 11. 一致性与时序设计

### 11.1 四层状态

```text
Git HEAD
   │ git diff --cached
Git Index
   │ git diff
Disk Workspace
   │ editor dirty buffer
Monaco Buffer
```

规则：

- Git API 永远不包含 Monaco 未保存缓冲区。
- 文件树状态来自 Git 快照，不从编辑器 dirty 状态伪造。
- Monaco dirty 状态可额外显示独立圆点，但不能标成 Git modified。
- 文件保存后先更新标签本地状态，再等待 Git 状态刷新。
- WebSocket 事件到达顺序不能替代文件版本校验。

### 11.2 自身写入与 watcher 回声

后端保存文件会触发 watcher。处理方式：

- 保存成功立即返回新 version。
- watcher 事件仍然发送，以保证其他浏览器标签同步。
- 发起保存的客户端收到相同 path/version 事件时视为确认，不重复加载。
- 若 version 不同，按新的外部修改处理。

### 11.3 Git 快照版本

每次成功重新计算状态后递增 `revision`。Diff 响应携带生成时的 `gitRevision`。当前 revision 变化后，前端将已打开 Diff 标为过期。

## 12. 性能设计

目标基线：

| 场景 | 目标 |
|---|---|
| 根目录首次展示 | P95 ≤ 2 秒 |
| 1 MiB 内文本文件打开 | P95 ≤ 500 ms |
| 外部文件事件展示 | P95 ≤ 1 秒 |
| 普通仓库 Git 状态 | P95 ≤ 2 秒 |
| 最近 50 条历史 | P95 ≤ 2 秒 |
| 普通单文件 Diff | P95 ≤ 1 秒 |

优化策略：

- 文件树懒加载，不递归扫描。
- Git 查询限流、去重和防抖。
- 大文件流式读取或拒绝完整加载。
- 大 Diff 先返回文件列表，再按文件请求内容。
- 提交详情按不可变 hash 缓存。
- Monaco model 按使用情况释放。
- 前端只局部失效受事件影响的 Query。

性能测试仓库至少包含：10 万文件、1 万提交、单目录 1 万节点、10 MB 文本文件四类样本。

## 13. 安全设计

- 默认只监听 `127.0.0.1`；若绑定非本机地址，必须另行加入认证和 TLS 方案。
- 所有相对路径都经 PathGuard 校验。
- 不向前端暴露任意命令执行能力。
- Git 子进程禁用 shell，参数由服务端白名单构造。
- `.git` 永久禁止通过文件 API 读取、编辑、重命名或删除。
- 符号链接默认只展示，不跟随到工作区外。
- 限制请求体、文件读取、Git 输出和 WebSocket 消息大小。
- 日志不记录文件正文、Git Diff、环境变量或凭据。
- 删除与覆盖必须前后端双重确认。
- 生产打包关闭开发服务器代理和源码目录任意静态暴露。

## 14. 可观测性

结构化日志字段：

- `requestId`
- `operation`
- `workspaceId`
- `relativePath`（必要时脱敏）
- `durationMs`
- `result`
- `errorCode`
- `gitExitCode`

推荐指标：

- API 请求时延和错误率。
- Git 命令时延、超时和输出超限次数。
- watcher 事件数、合并数和重同步次数。
- 当前 Monaco model 数量由前端开发诊断面板展示。

MVP 不要求接入外部监控平台，但日志格式应便于后续采集。

## 15. 测试设计

### 15.1 单元测试

- PathGuard：`..`、绝对路径、同前缀目录、符号链接逃逸、`.git`。
- Git porcelain v2 解析：普通、重命名、冲突、未跟踪。
- 历史和 numstat 解析：特殊字符、中文、换行提交信息。
- 文件编码、二进制、换行符和 final newline 检测。
- 文件版本生成及冲突判断。
- watcher 事件合并和序号。
- 前端 dirty、externalState 和标签状态转换。

### 15.2 集成测试

每个测试创建临时 Git 仓库：

- 普通目录与 Git 目录打开。
- 空仓库、Detached HEAD、Merge Commit。
- staged、unstaged、untracked、rename、delete、conflict。
- 根提交和 merge commit Diff。
- 外部修改、删除、重命名事件。
- 保存同时发生外部写入时返回 409。
- 大文件、二进制、未知编码和超大 Git 输出。

### 15.3 E2E 测试

- 打开工作区并按层级浏览文件。
- 打开多个文件，修改、保存、关闭。
- dirty 文件遭遇外部修改并完成三种冲突处理。
- 文件树响应外部新增、删除、重命名。
- 查看 staged/unstaged/all Diff。
- 浏览历史、加载更多、打开 commit 和单文件 Diff。
- 后端重启或 WebSocket 断线后的重同步。

### 15.4 兼容性测试

- Linux、macOS。
- Chrome、Edge 最新两个主要版本。
- Git 2.39+（本次隔离验证为 Git 2.40.0）。
- 文件名包含空格、中文、emoji、前导短横线。
- LF、CRLF、无末尾换行。

## 16. 配置项

```text
HOST=127.0.0.1
PORT=4311
GIT_PATH=git
FILE_WARN_BYTES=2097152
FILE_READONLY_BYTES=10485760
REQUEST_BODY_MAX_BYTES=12582912
GIT_TIMEOUT_MS=10000
GIT_MAX_OUTPUT_BYTES=52428800
WATCH_DEBOUNCE_MS=250
SHOW_HIDDEN_DEFAULT=true
SHOW_IGNORED_DEFAULT=false
```

配置读取失败应在启动期报错，不使用模糊的隐式降级。

## 17. 部署与运行

MVP 建议：

- 前端构建产物由 Fastify 静态托管。
- 单个启动命令启动 Node.js 服务。
- 工作区通过启动参数或“打开工作区”接口选择。
- 默认仅本机访问。
- 服务优雅退出时停止 watcher、取消 Git 子进程并关闭 WebSocket。

不建议首期采用容器作为唯一运行方式，因为容器访问宿主机任意本地项目会增加挂载配置成本；如用于远程部署，则必须在容器层限制可访问目录。

## 18. 关键验收映射

| 需求 | 设计落点 | 主要验证 |
|---|---|---|
| 文件树 | FileService、FileExplorer | 懒加载、排序、事件同步 |
| Monaco 编辑 | Editor Store、File API | 保存、dirty、编码和大文件 |
| Git 历史 | GitService、HistoryPanel | 分页、详情、根/合并提交 |
| Git Diff | DiffService、DiffPane | 四种范围、特殊文件、大 Diff |
| 外部变化同步 | WatchService、EventHub | 1 秒同步、断线重同步 |
| 防止覆盖 | 文件 version、409、ConflictDiff | 并发写入和冲突处理 |
| 路径安全 | PathGuard、GitRunner | 穿越、符号链接和命令注入测试 |

## 19. 需要在开发前冻结的参数

以下参数不影响总体架构，但应在 M0/M1 结束前确定：

- 是否首期提供系统目录选择器，还是通过输入绝对路径打开工作区。
- 文件新建、重命名、删除是否纳入首发；当前设计支持，计划列为增强项。
- Linux/macOS 之外是否要求首发支持 Windows。
- dirty 缓冲区是否需要浏览器崩溃恢复；当前建议使用 `sessionStorage`。
- 单目录分页阈值、大文件阈值和 Git 最大输出值。

## 20. V1.1 需求变更：分支切换与 Commit Graph

### 20.1 分支切换

新增本地、远程分支列表和分支切换能力：

- 顶部栏显示当前分支并提供分支选择器。
- 支持搜索本地与远程分支。
- 本地分支使用 `git switch <branch>`。
- 远程分支在不存在对应本地分支时使用 `git switch --track <remote>/<branch>`。
- Monaco 存在未保存内容时必须由用户确认，不能静默切换。
- Git 工作区存在未提交内容时，后端默认返回 `409 GIT_WORKTREE_DIRTY`；用户再次确认后可尝试保留修改切换。
- Git 自身判断修改会被覆盖时，切换失败并原样保留当前分支和工作区。
- 成功后刷新分支、HEAD、文件树、Git 状态、历史、提交图和已打开 Diff。
- 已打开文件继续使用外部文件变化机制校验新磁盘版本。

接口：

```text
GET  /api/git/branches
POST /api/git/switch
```

### 20.2 Commit Graph

新增全分支拓扑提交图：

- 使用 `git log --all --topo-order --date-order --parents --decorate=full` 获取数据。
- 展示提交节点、父子连线、分叉、合并和多条彩色轨道。
- 展示 HEAD、本地分支、远程分支和 Tag 装饰。
- 支持分页加载，默认每页 100 条。
- 点击节点复用提交详情和 Commit Diff。
- 历史页允许在线性历史与提交图之间切换。
- HEAD 或 refs 变化时提交图失效并提示刷新。

接口：

```text
GET /api/git/graph?cursor=&limit=100
```

### 20.3 安全约束

- 分支名必须来自后端实时分支列表，禁止将任意用户字符串直接作为 Git revision 执行。
- 分支切换命令禁用 shell，并仅在该写操作中允许 Git 获取索引锁。
- 不提供强制切换、自动丢弃修改或自动 stash。
- Commit Graph 和分支列表仍为只读查询。

## 21. 远程提交图与 worktree 设计扩展

### 21.1 需求与设计依据

2026-10-22 补充 B-009/B-010，正式行为、阶段和验收以[需求第 11～16 节](change-request-subworkspace-git.md#11-2026-10-22-扩展需求基线)为准，任务对应[专项计划 P7～P12](subworkspace-git-development-plan.md#4-2026-10-22-扩展实施计划)。第 20 节全分支图是“本机已有 refs”的能力，不包含自动获取远程提交。

### 21.2 身份与数据作用域

- 仓库组 ID 基于规范化 Git common-dir，worktree ID 标识工作目录及其独立 Git 上下文。独立 clone 不因远程相同而合并；别名不重复计数。
- fetch、refs/对象和登记清单属于共享仓库；HEAD、index、文件状态、working/staged Diff、文件树和分支切换属于指定 worktree。
- 保留原 repositoryId 到工作目录的兼容映射，逐步增加 repositoryGroupId/worktreeId；不能把旧 ID 直接重新解释为共享组。
- 主 worktree、默认分支、当前选中 worktree 是不同概念。状态失败返回未知，不以 0 参与清理判断；跨 worktree 汇总使用 `(worktreeId, path)`。

### 21.3 同步、历史与缓存

- 用户显式发起 fetch；后端使用登记远程和固定参数，按组去重，返回各远程状态。同步不执行 pull，不切分支、不改工作文件。
- 图和列表统一全部/当前/指定分支范围；默认图包括本地/远程分支、Tag 及登记 worktree HEAD 可达提交，内部 stash/reflog 不默认混入。
- refs 使用完整命名空间解析；图节点关联多个 refs/worktree HEAD。图页绑定 graphRevision，refs 变化重载首批，显示分页边界和加载状态。
- 监听 common-dir、packed-refs、登记与 worktree HEAD/index 的必要元数据；同组失效广播不覆盖 session 自己的选择和文件缓冲。资源降级仍可手动刷新。

### 21.4 关系图与后续移除

- 阶段 A 实现仓库 → worktree 图、独立状态、提交联动和只读清理预览；未推送、未合并、文件修改分别展示。
- 文件树删除/重命名 worktree 根目录需要受控保护，不能直接 `rm` 或移动目录绕过 Git 登记；普通 symlink 别名仍遵循原文件语义。
- 阶段 B 单独实现 Git worktree 移除：明确确认、预览版本复验、保留分支、保护主项/未知/有内容等目标，不提供强制或自动清理。完整条件引用需求第 13.4 节。

### 21.5 验证与修订记录

- AC-GG-01～AC-GG-06、AC-WT-01～AC-WT-07、AC-INT-01 的定义见[统一验收矩阵](change-request-subworkspace-git.md#15-验收与追溯矩阵)；阶段 A/B 分别验收。
- 2026-10-22：补充设计落点与现有基线的关系；本节为待实现设计，无功能完成或验收通过声明。

### 21.6 实现落点与运行边界（2026-10-22）

- `git-registry.ts` 规范化 common-dir/worktree 路径并解析 porcelain NUL 登记，主身份比较实际 git-dir 与 common-dir；`workspace-service.ts` 串行刷新登记、保留别名映射和原 repositoryId。
- `repository-tasks.ts` 在服务内按组共用 fetch 任务。heads 使用固定全量 refspec 并 prune 远程跟踪分支，tags 单独无 prune 同步；网络命令禁用交互提示，返回脱敏错误，成功时间只保存在进程内。
- `git-service.ts` 按 heads/remotes/tags/登记 HEAD 构建提交可达集合。图和列表共用版本化页，版本由 refs、登记 HEAD、范围和浅仓库标记计算；续页不匹配返回 `409 GRAPH_CHANGED`。根提交对空树、merge 对第一父提交。
- `worktree-service.ts` 最多并发 4 项、总览默认查询 40 项；每项有总查询时间预算。登记默认 200 项，超限不宣称全范围完整；不可查询项保留未知状态。默认分支只来自已知远程 HEAD，不猜测 main/master。
- `watch-service.ts` 保留工作区源码监听，另仅监听 Git 元数据；初始必要元数据超过 5000 项时降级。后台刷新与前台请求不互相覆盖登记快照，关闭工作区释放监听。
- `GitPanels.tsx` 实现原生 SVG 提交图、组到 worktree 关系图、筛选、双向导航及清理预览。`App.tsx` 的全部 Diff 打开每个可预览文件；图片带 session；`DiffViewer.tsx` 确保先销毁 Monaco widget 再回收模型。
- 新接口为 `GET /api/git/worktrees`、`GET /api/git/refs`、`GET /api/git/sync`、`POST /api/git/fetch`、`POST /api/git/editor-state`、`POST /api/git/worktrees/:id/removal-preview`；历史参数支持 `scope/ref/graphRevision` 和组/worktree 身份，原 repositoryId 继续有效。阶段 A 无 worktree DELETE 接口。
- 预览返回 token、保留分支、忽略内容/未保存/会话占用及逐项阻止原因；当前选择、主项、越界、dirty、locked/prunable、未知和无引用保留的 detached 提交均阻止。浏览器每 15 秒报告缓冲状态，会话有效期 45 秒，不包含编辑内容。

R3：阶段 A 已实现，实际检查与浏览器证据见验收报告第 8 节。上述运行限制不替代阶段 B 的执行前复验要求。


### 21.7 验证反馈界面与提交比较（R4）

- `GitGraphCommit.inCurrentHistory/inRemoteHistory` 分别表示是否被当前 worktree HEAD、全部已取得远程跟踪引用的任一 tip 包含，按解析后的 hash 执行祖先可达查询，不依据装饰或作者判断；无远程引用/查询失败使用 null。`GitHistoryPage.comparison` 返回 upstream 完整引用和领先/落后数，缺少 upstream 时为 null。
- graphRevision 始终绑定当前 HEAD 和 upstream，以免在同组切换 worktree 后沿用不同本地比较口径的旧页。比较查询遵守 Git 时间和输出上限，失败保留历史并显示未知；浅仓库明确限定为已知历史。
- `HistoryPanel` 在同一组件内切换固定全屏布局，保留范围、已加载页和所选提交；按钮或 Esc 退出，打开 Diff 返回编辑区。图与列表共享 HEAD 强调和提交归属标签；未加载的本地 HEAD 可通过当前分支范围定位。
- `WorktreePanel` 从已去重的登记项计算全局总数及修改/干净/未知数量；筛选不改变统计。扁平列表保留共享仓库关联并跨组按修改、干净、未知排序，主项清单可展开；默认不渲染详情栏，选中后才展开可关闭详情及原有操作。
- 追溯：GG-07/08、WT-09/10 → P13 → AC-GG-07/08、AC-WT-08。验收证据见验收报告第 9 节。


### 21.8 Worktree Git 地址分类（R5）

- `WorktreeOverview.groups[].remote` 返回 `GitRemoteAddresses`：`primaryName/primaryUrl/remotes/error`，其中各远程包含 fetchUrls 和 pushUrls。`git-remotes.ts` 只读 NUL 分隔的 remote URL 配置，保留多地址及含点远程名，移除 URL authority 凭证、query 和 fragment；未显式配置 push URL 时显示 fetch 地址作为默认 push 目标。配置无匹配与读取错误分别处理，不让地址失败破坏独立文件状态。
- 主分类地址优先 origin 的首个 fetch URL，无 origin 时按远程名选首个有效项。展示的是配置地址，不执行网络查询，也不解析 insteadOf 重写来猜测托管平台身份。相同脱敏展示地址可归入同一 UI 分类；不同协议/别名不自动合并。相对本地路径解析到对应 repositoryRoot 下的绝对位置。
- `GitPanels.tsx` 保留所有 common-dir base 及原 worktree ID，在地址分类下分别显示 base 名与 common-dir；同远程的独立 clone 不共享同步、清理或文件操作作用域。未配置/读取失败的 base 各自列出。
- 排序先保证地址和 base 的归属连续，再按各组最高文件状态优先级排列，base 内采用修改、干净、未知顺序。筛选不改变全局计数；隐藏没有匹配项的分类。详情按所选 worktree 的所属 base 展示其全部地址。
