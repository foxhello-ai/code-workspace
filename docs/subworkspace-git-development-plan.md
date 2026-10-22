# 子工作区 Git 支持开发计划

最近修订：2026-10-22。第 1～3 节保留子仓库发现的原始计划；[第 4 节](#4-2026-10-22-扩展实施计划)维护 B-009/B-010 的实施任务：P7～P11 已实现，P12 保留后续，不把原计划或文档落地等同于新功能完成。需求规则和验收口径统一引用[需求第 11～16 节](change-request-subworkspace-git.md#11-2026-10-22-扩展需求基线)。

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
- 打开 IM 聚合工作区后能发现 `api-service`、`worker-service` 等子仓库。
- 顶部栏和 Git 面板能清楚显示当前 Git 项目。
- 切换 Git 项目后，Git 修改、历史、分支和 Diff 都来自目标项目。

## 4. 2026-10-22 扩展实施计划

### 4.1 需求与任务映射

| 任务 | 需求 | 主要交付 | 依赖 | 验收 |
|---|---|---|---|---|
| P7 共享仓库与 worktree 模型 | WT-01、WT-02、WT-06 | common-dir 归组、登记解析、稳定 ID、兼容原 repositoryId、主项及范围边界 | 无 | AC-WT-01、AC-WT-04 |
| P8 远程同步 | GG-01、GG-06 | 受控 fetch、组级任务去重、各远程结果、同步时间、错误和 refs 失效 | P7 | AC-GG-01、AC-GG-06 |
| P9 完整历史和提交图 | GG-02～GG-05 | 范围一致、版本化分页、准确 refs、worktree HEAD 标记、完整文件 Diff 入口 | P7；同步联调依赖 P8 | AC-GG-02～AC-GG-05 |
| P10 Worktree 关系图与预览 | WT-03～WT-07 | 独立状态、同步指标、图/历史联动、只读清理预览、文件操作保护 | P7；联动依赖 P8/P9 | AC-WT-02～AC-WT-05、AC-WT-07 的阶段 A 部分 |
| P11 集成、浏览器验收与文档 | GG-01～GG-06、WT-01～WT-07 | 监听与 session 回归、隔离 fixtures、构建、浏览器操作证据、验收逐条记录 | P8～P10 | AC-INT-01 及阶段 A 全部适用用例 |
| P12 关联 worktree 移除 | WT-08 | 预览版本复验、确认、Git 移除、保留分支、失败保护 | 阶段 A 验收完成；作为后续阶段 B 单独实施 | AC-WT-06、AC-WT-07 的阶段 B 部分 |

2026-10-22：P7～P11 阶段 A 已实现并完成自动化与浏览器验证，具体证据和限制见验收报告第 8 节；P12 未实施，保持阶段边界。总任务计划对应 M12（P8/P9）、M13（P7/P10/P11）、后续 M14（P12）。

### 4.2 P7：先拆开身份与作用域

- [x] 在临时仓库用 Git 2.40.0 验证 common-dir、worktree porcelain NUL 解析及含空格/中文路径；明确将本功能最低 Git 版本调整为 2.39+，不回退解析人类表格。
- [x] 扩展 `src/shared/contracts.ts`，定义仓库组、worktree、独立状态、同步和图版本字段；旧 `repositoryId` 继续映射到工作目录。
- [x] 调整 `workspace-service.ts`，保留文件树目录入口，按 common-dir 归组并读取登记项；不把相同远程的独立 clone 合并。
- [x] 拆分共享 refs/对象查询上下文和 worktree HEAD/index/cwd 上下文，验证非当前 worktree 的状态不串用。

### 4.3 P8/P9：远程同步与完整历史

- [x] 调整 `git-service.ts`、`git-runner.ts`、`app.ts`、`config.ts`，构造受控 fetch，配置合理超时，非交互失败，按组串行/合并重复任务并返回各远程结果。
- [x] 同步完整分支范围，显式处理窄 refspec、远程删除、离线和部分失败；不改持久化远程配置、本地分支、工作文件或 index。
- [x] 图和线性历史统一范围参数，按完整 ref 类型构造装饰，加入所有已登记 worktree HEAD。
- [x] 分页绑定 graphRevision，显示加载进度/边界，refs 变化时重载；默认不包含 stash/reflog 等内部历史。
- [x] 调整 `api.ts`、`App.tsx`、`store.ts`，完成同步入口、范围选择、图与详情联动、全部文件 Diff 导航及图片请求 session 作用域。

### 4.4 P10：Worktree 图与清理预览

- [x] 独立查询每个 worktree 的文件分类、upstream ahead/behind、远程包含关系和默认分支祖先关系；无 upstream/未同步/查询失败准确标记。
- [x] 在 `App.tsx` 和 `styles.css` 实现仓库归组、关系图、主项/当前项、状态详情、过滤和提交定位；未知状态不得渲染为干净。
- [x] 扩展 `watch-service.ts`，监听公共 Git 元数据和必要的 worktree HEAD/index，限制并发/资源并支持手动刷新降级，不递归监听全部源码。
- [x] 在 `file-service.ts` 和文件 API 增加 worktree 根目录删除/重命名保护，保留普通 symlink 别名只删除链接的语义。
- [x] 返回只读清理预览，覆盖未保存缓冲、未推送提交、忽略文件、目录范围、locked/prunable、session 占用和状态版本；此阶段不接通执行删除。

### 4.5 P11：验证与发布门禁

- [x] 用本地 bare remote + 两个 clone 验证新远程分支/提交及部分失败，不依赖真实生产仓库或网络偶然状态。
- [x] 构造超过 200 条、含分叉/合并/Tag/本地带斜杠分支、多个 worktree 和 detached HEAD 的历史，按需求范围与 CLI 可达集合对照。
- [x] 验证 common-dir 去重、独立 clone 隔离、外部 refs/登记变化、目录外项、无 upstream、未知、超限及同组多 session；沿用现有文件和 Git 回归。
- [x] 运行 `npm run check`，记录实际类型检查、测试和构建结果；不得复用历史通过记录代替本次验证。
- [x] 浏览器逐条走通“打开 → 同步 → 范围/分页 → 提交 → 文件 Diff”及“仓库组 → worktree → 状态/图定位 → 清理预览”，记录截图、操作结果及 AC 编号。
- [x] 将实际支持能力、最低 Git 版本、限制和验收证据同步到 README、详细设计和验收报告；阶段 B 不在阶段 A 发布声明中标为完成。

### 4.6 P12：后续移除执行

- [ ] 阶段 A 通过后独立安排，不随图视图上线而默认启用。
- [ ] 新增专用 Git worktree 移除接口和确认流程，执行前重新核查目标、预览版本、未保存状态及 session 占用。
- [ ] 仅移除满足条件的关联 worktree，保留分支；拒绝 force、批量、自动 prune、越界及不明状态。
- [ ] 仅在可丢弃临时仓库验证成功移除、状态变化拒绝、并发/锁定/忽略文件/主项保护，以及成功后的登记和缓存刷新。

### 4.7 P13：验证反馈的历史与 Worktree 界面优化

对应 GG-07/08、WT-09/10；验收 AC-GG-07/08、AC-WT-08。P13 在阶段 A 上增量实施，P12 的删除边界保持不变。

- [x] 历史全屏与按钮/Esc 退出，保留范围、分页和选中项；从全屏打开 Diff 返回编辑器。
- [x] 本地 HEAD 强调与定位；后端按快照中的真实 hash 查询祖先可达集合及 upstream 差异，图和列表统一归属标签。
- [x] Worktree 全局统计、主项清单与标记；跨仓库按修改/干净/未知排序；紧凑行与按需详情。
- [x] 新增真实 Git 祖先/分叉集成回归和界面状态测试；运行类型检查、全量测试及生产构建。
- [x] 实际浏览器验收并将构建重启到本地验证入口，补齐文档与截图。

### 4.8 P14：Worktree 按 Git 地址分类

对应 WT-11 / AC-WT-09。独立 clone 的 common-dir 身份保持不变，仅增加远程地址的界面分类。

- [x] 在总览中返回配置的 fetch/push 地址、主展示地址及查询错误；URL 凭证不返回客户端。
- [x] 展示 Git 地址分类与本地 base 子分组，地址及数量可直接阅读；其他远程地址按需展开。
- [x] 保留全局统计、主/当前项、独立操作与按需详情；分类/base 修改优先，base 内按修改、干净、未知排序。
- [x] 新增同地址独立 clone、多远程、无 origin/无远程/地址错误及界面归属、筛选测试。
- [x] 全量检查、生产构建、隔离浏览器验收、文档证据及本地验证服务重启。

## 5. 更新记录

| 日期 | 修订 | 变化 | 交付状态 |
|---|---|---|---|
| 2026-10-22 | R2 | 对应 B-009/B-010，追加 P7～P12、需求/AC 映射、实现落点及阶段边界；保留原计划 | 文档已补充；功能与验收未执行 |
| 2026-10-22 | R3 | 实现 P7～P11：组/worktree 身份、fetch、版本化历史、关系图、预览、监听和根目录保护；记录隔离测试与生产构建浏览器验收 | 阶段 A 已实现；P12 未实施 |
| 2026-10-22 | R4 | P13 增量优化：历史全屏、本地/远程提交差异、全局 worktree 统计与紧凑详情 | 见验收报告第 9 节 |
| 2026-10-22 | R5 | P14：Git 地址分类、base 子分组、多远程展示及独立作用域回归 | 见验收报告第 10 节 |
