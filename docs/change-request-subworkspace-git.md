# 子工作区 Git 受控识别变更需求

## 1. 背景

当前 `Code Workspace` 支持打开一个本地目录，并基于该目录识别 Git 仓库、展示文件树、Git 修改、历史、分支和 Diff。

实际使用中，Codex 工作目录经常不是单一 Git 仓库，而是一个聚合目录：

```text
im-workspace/
  im-rpc -> /Volumes/.../im-rpc
  imv2-server -> /Volumes/.../imv2-server
  imv2-webv2 -> /Volumes/.../imv2-webv2
  imv3-uniapp -> /Volumes/.../imv3-uniapp
```

这些目录多数是符号链接，真实 Git 仓库可能位于一级目录，也可能位于二级目录，例如 `clients/web -> /path/web` 或 `services/im-rpc -> /path/im-rpc`。当前系统只检测工作区根目录是否为 Git 仓库，因此打开聚合目录后看不到子项目的受控状态、修改列表、分支、历史和 Diff。

## 2. 现状审核

### 2.1 已具备能力

- 文件树已支持打开 symlink 指向的目录和文件。
- Watcher 已配置 `followSymlinks: false`，避免打开聚合目录时递归监听大量子仓库导致 `EMFILE`。
- Git 能力已覆盖单仓库：状态、分支、切换、历史、提交图、Diff、图片 Diff。

### 2.2 当前限制

- `WorkspaceService.open()` 只在工作区根目录执行 `git rev-parse --show-toplevel`。
- `WorkspaceInfo.git` 只能表达一个 Git 仓库。
- `GitService` 只有一个 `gitRunner`，所有 Git API 默认指向根仓库。
- `/api/files/tree` 的 Git 状态标识只在根目录是 Git 仓库时生效。
- 前端 Git 面板没有“当前正在查看哪个项目 Git”的明确标识。
- 打开聚合目录时，用户无法知道 Git 面板不可用是因为没有仓库，还是因为仓库位于未扫描到的子目录深度内。

## 3. 目标

支持“聚合工作区 + 配置深度内子 Git 仓库”的使用模式，让用户能在同一个 Code Workspace 中：

- 看到配置深度内的子目录是否是 Git 受控项目。
- 选择当前 Git 项目。
- 在明显位置看到当前 Git 面板对应的项目名称、路径和分支。
- 查看所选子项目的 Git 修改、历史、分支、Diff 和提交图。
- 在文件树中看到子项目自身的 Git 修改标识。

## 4. 非目标

本次变更不做：

- 多仓库同时聚合提交。
- 跨仓库统一 Diff。
- 跨仓库批量 stage、commit、push、pull。
- 自动递归扫描任意深度 Git 仓库。
- 对 `node_modules`、`target`、`dist` 等生成目录进行 Git 状态扫描。
- 终端、Codex 会话或 AI 功能。

## 5. 需求完善

### 5.1 子仓库发现深度配置

系统应支持通过配置控制 Git 子仓库发现深度，而不是写死只扫描一级目录。

建议新增配置项：

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `GIT_DISCOVERY_DEPTH` | `1` | 从工作区根目录向下发现 Git 仓库的最大目录深度。`0` 表示只检测根目录，`1` 表示根目录和一级目录，`2` 表示根目录、一级和二级目录。 |
| `GIT_DISCOVERY_MAX_DIRS` | `200` | 单次发现最多检查的目录数量，避免大型目录树卡住打开流程。 |
| `GIT_DISCOVERY_TIMEOUT_MS` | `5000` | Git 仓库发现总耗时上限，超时后返回已发现结果并提示发现不完整。 |

默认建议为 `1`，以兼容当前 IM 聚合工作区；用户可按需配置为 `2`。

### 5.2 子仓库发现

系统打开工作区后，应发现以下 Git 项目：

- 工作区根目录本身是 Git 仓库时，加入 Git 项目列表。
- 工作区根目录下配置深度内的目录是 Git 仓库时，加入 Git 项目列表。
- 工作区根目录下配置深度内的 symlink 指向目录且目标是 Git 仓库时，加入 Git 项目列表。

发现规则：

- 深度从工作区根目录开始计算，根目录为 `0`。
- 当 `GIT_DISCOVERY_DEPTH=1` 时，扫描根目录和一级目录。
- 当 `GIT_DISCOVERY_DEPTH=2` 时，扫描根目录、一级目录和二级目录。
- 如果某个目录已识别为 Git 仓库，不继续向它的子目录递归发现，避免把 Git 仓库内部的依赖、子模块或构建目录误扫为普通工作区结构。
- 发现过程应跳过 `.git`、`node_modules`、`target`、`dist`、`build`、`coverage`、`.gradle`、`.idea`、`.cursor`。
- 如触达 `GIT_DISCOVERY_MAX_DIRS` 或 `GIT_DISCOVERY_TIMEOUT_MS`，应返回已发现仓库，并在工作区信息中标记发现结果不完整。

发现结果应包含：

- `id`：稳定标识，可由逻辑路径或真实仓库路径生成。
- `name`：项目名，优先使用工作区内显示名，例如 `im-rpc`。
- `workspacePath`：工作区相对路径，例如 `im-rpc`。
- `repositoryRoot`：真实 Git 根目录。
- `branch`：当前分支。
- `head`：当前提交。
- `detached`：是否 detached HEAD。
- `current`：是否为当前 Git 面板选中的项目。
- `discoveryDepth`：发现该仓库时所在深度。

### 5.3 当前 Git 项目选择

打开工作区后默认选择规则：

1. 如果根目录本身是 Git 仓库，默认选择根仓库。
2. 如果根目录不是 Git 仓库，但配置深度内发现子仓库，默认选择排序后的第一个子仓库。
3. 如果没有发现任何 Git 仓库，Git 面板显示“未发现 Git 项目”。

用户可以在顶部栏或 Git 面板顶部切换当前 Git 项目。

### 5.4 当前受控项目标识

界面必须在明显位置展示当前 Git 项目，避免用户误以为正在查看整个聚合目录。

建议展示位置：

- 顶部栏分支选择器左侧或合并为一个 Git 项目选择器。
- Git 修改面板顶部。
- Git 历史面板顶部。

展示内容：

```text
Git 项目：im-rpc
路径：im-rpc
分支：feature/demo
```

空间不足时可展示：

```text
im-rpc · feature/demo
```

悬浮提示展示完整真实路径。

### 5.5 Git API 作用域

所有 Git API 应支持指定项目：

```text
GET  /api/git/repositories
GET  /api/git/repository?repositoryId=
GET  /api/git/status?repositoryId=
GET  /api/git/branches?repositoryId=
POST /api/git/switch
GET  /api/git/history?repositoryId=
GET  /api/git/graph?repositoryId=
GET  /api/git/commits/:hash?repositoryId=
GET  /api/git/diff?repositoryId=&scope=&path=
GET  /api/git/diff/commits/:hash?repositoryId=&path=
GET  /api/git/image?repositoryId=&source=&path=&hash=
```

兼容策略：

- 如果只有一个 Git 项目，可允许省略 `repositoryId`。
- 如果有多个 Git 项目且未传 `repositoryId`，后端使用当前选中项目。
- 后端不能仅依赖前端传入的 `repositoryRoot`，必须通过已发现的 `repositoryId` 映射。

### 5.6 路径语义

Git API 中的 `path` 应为仓库相对路径，而不是工作区根相对路径。

示例：

```text
工作区路径：im-rpc/im-common/src/main/java/A.java
Git 项目：im-rpc
Git path：im-common/src/main/java/A.java
```

文件树返回 Git 状态时，后端需要把工作区路径映射到所属 Git 项目，再转换为该仓库内路径。

### 5.7 文件树 Git 状态

文件树应支持多仓库状态标识：

- 子仓库根目录如果有修改，显示 `descendantChanged = true`。
- 展开子仓库后，子目录和文件显示该仓库内的 Git 状态。
- 不同仓库的状态不能互相污染。
- 未选择 Git 项目时，文件树仍可显示所有发现仓库的状态摘要。

### 5.8 Git 面板行为

Git 修改、历史、提交图、分支切换都作用于当前选中的 Git 项目。

切换 Git 项目时：

- Git 修改面板刷新为目标项目状态。
- Git 历史面板刷新为目标项目历史。
- 已打开的 Diff 标签应标记为过期，或在标题中保留所属项目名。
- 分支选择器切换为目标项目的分支列表。

### 5.9 Diff 标签标题

Diff 标签标题必须包含项目名，避免多仓库中同名文件混淆。

示例：

```text
im-rpc · working: im-common/pom.xml
imv2-server · 3a91c2b: src/main/resources/app.yml
```

### 5.10 文件监听与刷新

保持 `followSymlinks: false`，避免聚合目录打开时监听真实子仓库全量内容。

刷新策略建议：

- 当前选中 Git 项目的状态由用户刷新、Git 面板打开、文件树展开、或定时轻量刷新触发。
- 对 symlink 子仓库不做全量 watcher 监听。
- 后续如需实时感知子仓库变化，可只监听已选 Git 项目的根目录，并继续忽略 `.git/objects`、`node_modules`、`target`、`dist`。

## 6. 推荐方案

### 6.1 后端模型

新增 `GitRepositoryInfo`：

```ts
interface GitRepositoryInfo {
  id: string;
  name: string;
  workspacePath: string;
  repositoryRoot: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  current: boolean;
  discoveryDepth: number;
}
```

扩展 `WorkspaceInfo`：

```ts
interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  openedAt: string;
  git: null | GitRepositoryInfo;
  repositories: GitRepositoryInfo[];
}
```

保留 `git` 字段作为当前选中 Git 项目，降低前端改动范围。

### 6.2 后端服务

建议新增或调整：

- `WorkspaceService.discoverGitRepositories(depth, maxDirs, timeoutMs)`：按配置发现根仓库和子仓库。
- `WorkspaceService.selectGitRepository(repositoryId)`：切换当前 Git 项目。
- `GitService.context(repositoryId?)`：按项目获取 `GitRunner`。
- `GitService.toRepositoryPath(workspacePath, repositoryId)`：工作区路径转仓库路径。

### 6.3 前端交互

顶部栏新增 Git 项目选择器：

```text
[Code Workspace] [im-workspace] [Git: im-rpc · main ▼] [刷新] [切换工作区]
```

Git 面板顶部增加当前项目横条：

```text
Git 项目
im-rpc · main
im-rpc
```

如果没有 Git 项目：

```text
未发现 Git 项目
当前工作区根目录和配置发现深度内未发现 Git 仓库。
```

## 7. 验收标准

### 7.1 聚合工作区

给定工作区：

```text
workspace/
  repo-a -> /tmp/repo-a
  repo-b -> /tmp/repo-b
  notes.txt
```

当 `repo-a` 和 `repo-b` 都是 Git 仓库，且 `GIT_DISCOVERY_DEPTH >= 1` 时：

- 打开 `workspace` 后，Git 项目列表包含 `repo-a` 和 `repo-b`。
- 默认选中一个子仓库。
- 顶部栏能看到当前选中的 Git 项目名。
- 切换到 `repo-b` 后，Git 修改、历史、分支和 Diff 都来自 `repo-b`。

### 7.2 二级仓库发现

给定工作区：

```text
workspace/
  services/
    repo-a -> /tmp/repo-a
  clients/
    repo-b -> /tmp/repo-b
```

当 `GIT_DISCOVERY_DEPTH=1` 时：

- Git 项目列表不包含 `services/repo-a` 和 `clients/repo-b`。
- Git 面板提示可提高发现深度或打开具体子目录。

当 `GIT_DISCOVERY_DEPTH=2` 时：

- Git 项目列表包含 `services/repo-a` 和 `clients/repo-b`。
- 顶部栏展示项目名时能区分同名仓库，必要时显示 `services/repo-a`。

### 7.3 文件树状态

- `repo-a` 内有未提交修改时，根文件树中的 `repo-a` 有明显修改标识。
- 展开 `repo-a` 后，具体修改文件有 Git 状态标识。
- `repo-a` 的修改不会显示到 `repo-b`。

### 7.4 Diff 标识

- 从 `repo-a` 打开的 Diff 标签标题包含 `repo-a`。
- 切换到 `repo-b` 后，原 `repo-a` Diff 不会被误认为是当前项目 Diff。

### 7.5 性能

以 IM 聚合工作区为基准：

- 打开工作区不触发 `EMFILE`。
- 打开后 2 秒内显示根文件树。
- 获取 Git 项目列表不递归扫描 `node_modules`、`target`、`dist`。
- `GIT_DISCOVERY_DEPTH=2` 时仍遵守 `GIT_DISCOVERY_MAX_DIRS` 和 `GIT_DISCOVERY_TIMEOUT_MS`。
- 切换 Git 项目后，Git 状态查询遵循现有 Git 超时配置。

### 7.6 安全

- 文件 API 仍禁止直接访问 `.git`。
- `repositoryId` 必须来自后端发现结果，前端不能传任意路径执行 Git。
- Git 命令继续使用 `spawn` 参数数组，不经过 shell。
- 删除 symlink 目录只删除链接本身，不删除链接目标真实目录。

## 8. 风险与待确认

| 风险 | 影响 | 建议 |
|---|---|---|
| 子仓库数量过多 | Git 状态查询变慢 | 默认只查当前项目，文件树只做可见节点状态；发现阶段受 `GIT_DISCOVERY_MAX_DIRS` 保护 |
| 发现深度过大 | 打开工作区变慢 | 默认深度为 1，建议 UI 或文档提示生产使用不超过 2 |
| symlink 目标在工作区外 | 文件访问范围扩大 | 当前产品已按用户需求允许工作区内 symlink；需在 UI 显示真实路径提示 |
| 多仓库同名文件 | Diff 标签混淆 | 标题必须带项目名 |
| 子仓库 watcher 全量监听 | 再次触发 `EMFILE` | 初期不跟随 symlink 监听；只按需刷新 |
| Git API 兼容性 | 前端改动面增大 | 保留 `WorkspaceInfo.git` 表示当前项目，新增 `repositories` |

## 9. 实施拆分

### P1：发现与选择

- 扩展共享类型。
- 打开工作区时按 `GIT_DISCOVERY_DEPTH` 发现根仓库和子仓库。
- 增加发现深度、最大目录数和发现超时配置。
- 新增 Git 项目列表 API。
- 前端展示当前 Git 项目选择器。

### P2：Git API 多仓库化

- `GitService` 支持 `repositoryId`。
- 修改 Git 状态、分支、历史、图、Diff、图片 Diff API。
- Diff 标签加入项目名前缀。

### P3：文件树 Git 状态

- 将文件树路径映射到所属仓库。
- 根目录显示子仓库受控状态摘要。
- 展开子仓库后显示具体文件 Git 状态。

### P4：验证与文档

- 增加 symlink 子仓库集成测试。
- 增加多仓库 Git API 测试。
- 更新 README、详细设计和验收报告。

## 10. 审核结论

该需求成立，属于当前 symlink 工作区支持后的必要补齐项。

推荐按“当前选中 Git 项目”的方式实现，而不是一次性把多个仓库的 Git 状态混成一个列表。这样能保持 Git 语义清晰，也能避免大型聚合工作区下性能不可控。

本变更应进入 V1.2 或 V1.1 后续增强，不建议和基础文件树 symlink 支持混在同一个提交中实现。
