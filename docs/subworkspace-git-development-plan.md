# 子工作区 Git 支持开发计划

## 1. 目标

按 `docs/change-request-subworkspace-git.md` 实现聚合工作区中的多 Git 仓库支持。

核心交付：

- 可配置发现深度：`GIT_DISCOVERY_DEPTH`。
- 发现根目录、一级或二级 symlink/普通目录中的 Git 仓库。
- Git 面板明确展示当前受控项目。
- Git 状态、分支、历史、提交图、Diff 按当前 Git 项目工作。
- 文件树能显示子仓库的 Git 修改状态。

## 2. 实施阶段

### P1：配置与共享模型

- 新增配置：
  - `GIT_DISCOVERY_DEPTH`
  - `GIT_DISCOVERY_MAX_DIRS`
  - `GIT_DISCOVERY_TIMEOUT_MS`
- 新增 `GitRepositoryInfo`。
- 扩展 `WorkspaceInfo.repositories`。
- 保留 `WorkspaceInfo.git` 作为当前选中 Git 项目。

### P2：仓库发现与选择

- `WorkspaceService.open()` 中按配置发现 Git 仓库。
- 支持 symlink 目录目标作为候选。
- 发现 Git 仓库后不继续扫描其子目录。
- 增加当前仓库选择能力。
- 新增 API：
  - `GET /api/git/repositories`
  - `POST /api/git/repository/select`

### P3：GitService 多仓库化

- Git API 支持 `repositoryId`。
- 未传 `repositoryId` 时使用当前选中仓库。
- 所有 Git 操作只能使用后端已发现仓库，前端不能传真实路径。

### P4：文件树 Git 状态

- 将工作区路径映射到所属仓库。
- 子仓库根目录显示 descendant changed。
- 展开子仓库后显示具体文件状态。

### P5：前端交互

- 顶部栏增加 Git 项目选择器。
- Git 修改和历史面板顶部展示当前 Git 项目。
- 切换 Git 项目时刷新 Git 查询。
- Diff 标签标题包含项目名。

### P6：测试与验证

- 覆盖 `GIT_DISCOVERY_DEPTH=0/1/2`。
- 覆盖 symlink 子仓库。
- 覆盖多仓库 status、branches、diff。
- 验证真实 IM 聚合工作区。

## 3. 验收标准

- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run build` 通过。
- 打开 IM 聚合工作区后能发现 `im-rpc`、`imv2-server` 等子仓库。
- 顶部栏和 Git 面板能清楚显示当前 Git 项目。
- 切换 Git 项目后，Git 修改、历史、分支和 Diff 都来自目标项目。
