# Code Workspace MVP 验收报告

范围说明（2026-10-22 补充）：第 1～7 节为既有 MVP/V1.1 的历史报告，不代表当前新增范围已验证。B-009/B-010 的验收状态统一见[第 8 节](#8-远程提交图与-worktree-扩展验收)。

## 1. 结论

文件树、Monaco 编辑、Git 历史、Git Diff、外部文件变化同步五个核心模块已实现，生产构建和服务启动验证通过。

产品边界符合设计：不包含 Codex 会话、终端、PTY、AI Commit 或 AI Diff，Git 功能保持只读。

## 2. 实现映射

| 需求 | 实现位置 | 状态 |
|---|---|---|
| 工作区打开/关闭 | `WorkspaceService`、打开页、顶部关闭入口 | 完成 |
| 文件树 | `FileService.tree`、递归懒加载 `Tree` 组件 | 完成 |
| Monaco 编辑 | `App.tsx`、Zustand 标签缓冲区 | 完成 |
| 安全保存 | 文件版本摘要、原子替换、409 冲突 | 完成 |
| 外部变化同步 | chokidar、EventHub、WebSocket | 完成 |
| 编辑冲突 | dirty 状态保护、Monaco Diff、版本选择 | 完成 |
| Git 状态 | porcelain v2 NUL 解析和修改分组 | 完成 |
| Git Diff | working、staged、all、commit | 完成 |
| Git 历史 | 50 条分页、详情、文件 Diff | 完成 |
| 路径安全 | PathGuard、realpath、`.git` 禁止访问 | 完成 |
| 大文件/二进制 | 分类、只读阻断和专用提示 | 完成 |

## 3. 自动化验证

执行命令：

```text
npm run check
```

结果：

- TypeScript 服务端类型检查：通过。
- TypeScript Web 端类型检查：通过。
- Vitest：2 个测试文件、6 个测试全部通过。
- Vite 生产构建：通过。
- Monaco 及语言 Worker：本地打包成功，不依赖运行时 CDN。

覆盖场景：

- 合法工作区文件访问。
- `../` 路径穿越阻止。
- `.git` 内部路径阻止。
- 符号链接逃出工作区阻止。
- 文件读取和原子保存。
- 外部修改后的旧版本保存返回 409。
- Git 修改及未跟踪文件识别。
- HEAD 到工作区的单文件 Diff。
- Git 历史、提交详情和根提交 Diff。

## 4. 生产启动验证

执行：

```text
npm run build
npm start
```

验证结果：

- 服务成功监听 `http://127.0.0.1:4311`。
- `GET /health` 返回 `{"ok":true}`。
- `GET /` 返回生产构建后的 Web 页面，HTTP 200。

## 5. 设计限制

- 首发目标平台为 Linux、macOS；Windows 尚未列入首发验收。
- 单活动工作区，不支持多工作区并行。
- 未知编码和二进制文件不进入文本编辑器。
- 默认超过 10 MiB 的文件不返回完整正文。
- Git 操作只读。
- Merge Commit 使用第一父提交作为 Diff 基线。
- 默认仅本机访问；对外部署需要增加认证与 TLS。

## 6. 发布建议

当前版本可作为 V1.0 MVP 进入人工浏览器验收。建议人工验收时使用真实中型仓库重点检查：

- 外部格式化器连续写入时的编辑器同步。
- dirty 文件被外部修改时的冲突选择。
- staged 与 unstaged 同时存在时的分类和 Diff。
- 大型提交中逐文件查看 Diff 的交互体验。

## 7. V1.1 变更验收

- 分支选择器能展示本地和远程分支并标识当前分支。
- 未保存编辑或未提交修改不会被静默覆盖。
- 成功切换分支后 HEAD、文件树、Git 状态和历史同步刷新。
- Commit Graph 能展示全分支拓扑、分叉、合并、HEAD、分支和 Tag。
- 点击图节点可查看原有 Commit 详情及文件 Diff。

## 8. 远程提交图与 worktree 扩展验收

- 日期：2026-10-22；范围：B-009、B-010 阶段 A，P7～P11。
- 需求基线：[GG/WT 与 AC 矩阵](change-request-subworkspace-git.md#15-验收与追溯矩阵)。实施依据：[专项开发计划](subworkspace-git-development-plan.md#4-2026-10-22-扩展实施计划)。
- 结果：阶段 A 已实现并通过下述检查与浏览器路径验证；P12/WT-08 实际移除没有实现，没有 DELETE 接口，AC-WT-06 及 AC-WT-07 的执行删除部分未执行。
- 构建身份：当前 main 的未提交实现，基线及源码校验值见[验证记录](evidence/2026-10-22-git/verification.json)，未发布或部署生产服务。
- 环境：macOS；Node 22.22.0、Git 2.40.0。最低 Git 要求明确调整为 2.39+；未声称在 Git 2.30 下兼容 NUL 登记参数。

### 8.1 自动化及构建

`npm run check` 通过：类型检查通过、5 个测试文件共 31 项测试通过（原有 22 项 + 新增 9 项）、生产构建通过。随后扩大分页 fixture 至含分叉/merge/detached 的 229 条提交并加强主项/越界断言，单独复跑新增 9 项全部通过。构建保留原有 Monaco 大 chunk 提示；当前环境 npm 版本老旧，产生 Node 版本兼容警告，未导致检查失败。

新增测试位于 `src/server/git-extensions.test.ts`，均使用可丢弃临时目录、本地 bare remote、两个 clone 和关联 worktree；没有对 示例仓库 仓库 fetch、修改或删除。

| AC 编号 | 结果与实际覆盖 |
|---|---|
| AC-GG-01 | 通过：producer 推送新远程分支和多文件提交；窄 refspec 的 consumer 经同步可读新提交/Diff，HEAD、工作文件和持久配置保持原值。浏览器验证新远程提交出现及双文件 Diff。 |
| AC-GG-02 | 通过：全部、当前、已知完整 ref 范围正确；拒绝 refs/stash 作为指定范围。浏览器切换图/列表保留当前分支范围，指定远程引用为 2/2，不 checkout。 |
| AC-GG-03 | 通过：229 条含分叉/merge/detached 的提交，加载到底与 CLI 可达集合一致，无重复；分页期间新增引用返回 409。浏览器另一个 fixture 实际加载至 228/228。 |
| AC-GG-04 | 通过：codex/long、fix/side、feat/local 为本地，upstream/topic 为远程，带斜杠及 annotated Tag 正确处理；一个节点可显示多引用和 worktree HEAD。 |
| AC-GG-05 | 通过：根提交的 3 个文件、merge 相对第一父提交的 2 个文件、逐文件 Diff 均一致；浏览器“全部 Diff”打开 a.txt/b.txt 两个标签。导航离开 Diff 后复验无新增 Monaco 模型销毁错误。 |
| AC-GG-06 | 通过：完整 heads 同步覆盖窄 refspec，删除远程分支仅清理远程跟踪引用，本地分支/Tag 保留；本地 HTTP 401 认证拒绝、错误脱敏、重复同步合并及 Git 命令超时均验证。同步失败后本地历史可读。 |
| AC-WT-01 | 通过：含空格/中文路径、symlink 别名不重复；相同 remote 的独立 clone 分组不同；从关联目录打开仍可识别主 worktree。 |
| AC-WT-02 | 通过：各目录 staged/unstaged/untracked/conflict、无 upstream、ahead/behind、未发布和 detached 独立；同一文件同时暂存/未暂存只计一个变更文件，组汇总按 worktree 分开。 |
| AC-WT-03 | 通过：浏览器关系图显示主项/当前项、路径及文字状态；干净筛选、节点选择、独立状态、清理预览及提交定位均走通，编辑标签保留。 |
| AC-WT-04 | 通过：外部、locked、missing/prunable 登记显示；外部登记 ID 不能用于 status 操作；状态上限为未知，登记上限显示 partial 且拒绝宣称完整图。 |
| AC-WT-05 | 通过：干净但未发布的关联项提示保留分支；忽略内容、未保存缓冲、会话占用、锁定、dirty、无 refs 保存的 detached 分别检查。仅显示只读预览。 |
| AC-WT-07（A） | 通过：主项、当前项、越界、dirty、locked、未保存及 detached 保留条件有阻止原因；普通删除/重命名根目录返回 409，删除 symlink 只移除链接。未验证执行删除。 |
| AC-INT-01 | 通过：外部 refs 通过 WebSocket 通知，外部新增 worktree 可读取；并发刷新不覆盖新登记，同组任务合并，session 选择/权限和图片 query 作用域隔离；各测试关闭 app 释放监听。 |
| AC-WT-06 / AC-WT-07（B） | 未执行：P12 后续阶段，不以预览通过代替移除验收。 |

### 8.2 浏览器操作证据

通过 Codex 浏览器实际操作生产构建（临时验证端口 43111），没有使用接口成功代替 UI 路径。

1. 打开 `scripts/create-git-acceptance-fixture.mjs` 输出的临时工作区，进入 Git 历史，首次显示本地快照和同步入口。
2. 点击同步，观察 origin 成功和新远程提交；全部图从 100 加载到 200、228/228；切换当前分支及列表为 1/1，选定 origin/feat/remote 为 2/2。
3. 选择远程提交，查看两项文件，点击全部 Diff，确认两个标签与实际文本差异。
4. 进入 worktree 图，查看主目录的 1 个未暂存文件及关联目录干净状态；筛选干净项，选择关联项，看到 1 个未被远程包含的提交，打开只读预览；定位其提交后，顶部选择和 HEAD 标记对应关联目录。
5. 最终构建重新打开并复验同步、指定引用、多文件 Diff、预览和 Diff 卸载，控制台未出现新增错误。

| 证据 | 可核对内容 |
|---|---|
| [history-all.png](evidence/2026-10-22-git/history-all.png) | 同步成功、全部范围、100/228 进度、准确的本地/远程/Tag/worktree 标记与延续线 |
| [commit-diff.png](evidence/2026-10-22-git/commit-diff.png) | 指定远程引用 2/2、两文件入口、两个 Diff 标签与实际差异 |
| [worktree-graph.png](evidence/2026-10-22-git/worktree-graph.png) | 组到主/关联 worktree 的关系图、当前项、独立文件状态 |
| [worktree-preview.png](evidence/2026-10-22-git/worktree-preview.png) | 文件干净但未发布 1 提交、upstream/默认分支关系、保留分支与只读清理预览 |

### 8.3 已知边界及未覆盖项

- 远程指标只依据已取得的本地引用；同步时间只保留在服务进程内，重启不宣称最新。实际公网 SSH/凭据管理器交互、断网硬件环境未进行验收；已验证本地 401、部分失败、错误脱敏和命令超时。
- 元数据监听初始最多 5000 项，超限降级手动刷新；其他 worktree 源码不递归监听。当前覆盖外部 refs/登记和 session 关闭，不包含长时间压力测试或不同平台的文件系统事件验证。
- 状态总览默认 40 项、并发 4，每个 worktree 有查询预算；登记默认 200 项。无 upstream/默认分支未知、超限和失败不显示为干净。仅在 Git 2.40.0/macOS 实测，Linux 与 Git 2.39 的最低版本矩阵尚未执行。
- 预览会话信息依赖浏览器心跳，不能证明外部工具已退出；预览 token 为后续执行前复验准备，当前无实际删除。后台浏览器被暂停时占用信息可能过期，因此阶段 B 必须重新审视执行门禁。
- 本次只交付本地代码及文档，不修改真实 示例仓库 工作目录，不产生发布/部署或 PR。

更新记录：R2 的文档登记保留于各需求/计划修订表；R3（2026-10-22）补充阶段 A 的实际实现、检查和浏览器证据。阶段 B 保持未实施。


## 9. 历史与 Worktree 验证反馈优化（R4）

2026-10-22，根据用户提供的两张实机截图完成 P13（GG-07/08、WT-09/10），已重启本地验证服务 `http://127.0.0.1:43110`，页面返回 HTTP 200、健康检查通过。实现及本轮证据独立于第 8 节的 R3 快照，源码校验见[本轮验证记录](evidence/2026-10-22-git-ui/verification.json)。

`npm run check` 通过：类型检查、6 个测试文件共 36 项测试及生产构建通过。较上一轮增加 2 项真实 Git 集成测试和 3 项界面状态回归。随后仅调整全屏仓库摘要横向布局，重新执行 `npm run build` 通过。原有 Monaco chunk 大小及 npm 版本警告仍存在。

| 验收 | 结果与证据 |
|---|---|
| AC-GG-07 | 浏览器实际进入全屏，加载 100 → 200 / 230 条后 Esc 退出，加载数量和选择保留；切换图/列表状态一致。从全屏打开远程两文件提交的全部 Diff，退出全屏并打开 a.txt、b.txt 两个标签。控制台未发现错误。 |
| AC-GG-08 | 真实 Git 集成验证本地领先 1、远程领先 2；未带 refs 装饰的远程祖先被准确分类；同组切换 worktree 改变比较快照。无远程引用及 detached upstream 返回未知。界面测试验证未加载 HEAD 的定位。浏览器隔离示例实际显示领先 1/落后 1、绿色本地 HEAD、本地独有与远程独有，见[全屏历史](evidence/2026-10-22-git-ui/history-fullscreen.jpg)。 |
| AC-WT-08 | 两个独立共享仓库共 5 个登记项：修改 1、干净 3、未知 1；跨仓库排序正确，筛选未知后仍保留全局 5/1/3/1 统计。默认没有详情占位；点击行展示详情、关闭后恢复全宽；展开主工作区清单可见两个主项的路径与分支。见[紧凑总览](evidence/2026-10-22-git-ui/worktree-overview.jpg)、[按需详情](evidence/2026-10-22-git-ui/worktree-detail.jpg)、[主工作区清单](evidence/2026-10-22-git-ui/worktree-main.jpg)。 |

验证使用临时 bare remote、clone、关联 worktree、缺失登记和独立 clone，没有对真实 示例仓库 或 IM 仓库执行 fetch、修改或删除。远程比较只代表已获取的本地 refs；统计包含已登记且已返回的项，超限/失败保留未知及边界提示。P12 实际移除保持后续阶段。

## 10. Worktree 按 Git 地址分类（R5）

2026-10-22，完成 WT-11 / P14 / AC-WT-09。Worktree 总览按“Git 远程地址 → 本地 base（common-dir）→ Worktree”展示，分类标题直接显示地址、base 数、Worktree 数和状态统计；其他 fetch/push 地址可展开，详情展示远程名称、地址和所属 common-dir。源码身份及检查结果见[本轮验证记录](evidence/2026-10-22-git-address/verification.json)。

优先使用 origin 的首个 fetch URL；没有 origin 时使用按名称排序的首个有效 fetch 远程。地址在服务端移除 URL 用户信息、query 和 fragment，SCP 地址保留惯用的 `git@`。相同展示地址的独立 clone 归入同一界面分类，但各自保留 base、主工作区和操作作用域。无远程或地址查询失败分别提示，并按各 base 展示。分类和 base 修改优先，base 内按修改、干净、未知排序；该归属分组替代 R4 的跨仓库平铺顺序。

### 10.1 自动化及构建

`npm run check` 通过：类型检查、6 个测试文件共 39 项测试、生产构建通过。本轮增加 2 项真实 Git 集成测试和 1 项界面回归，覆盖同地址独立 clone、多 fetch/push URL、带点远程名、无 origin、无远程、地址查询失败、凭证脱敏，以及分组后的统计、筛选和详情归属。原有 npm 版本和 Monaco chunk 大小提示仍存在。

### 10.2 浏览器验收与证据

通过 Codex 浏览器实际操作隔离生产构建 `http://127.0.0.1:43111`，使用临时 Git fixture：两个 Git 地址、三个独立 base、五个 Worktree，其中修改 2、干净 2、未知 1。没有对真实 示例仓库 或 IM 仓库执行 Git 操作。

| 验收场景 | 结果与证据 |
|---|---|
| 地址分类与 base 归属 | 支付地址下有两个独立 base、四个 Worktree；API 地址下有一个 base、一个 Worktree。关联项列在所属 base 下，各主项独立标识，见[地址分类](evidence/2026-10-22-git-address/address-groups.jpg)。 |
| 全局统计及组内顺序 | 全局为 5 / 修改 2 / 干净 2 / 未知 1；main base 内依次为修改的主项、干净关联项、缺失登记项。见[总览](evidence/2026-10-22-git-address/overview.jpg)。 |
| 多远程地址 | 展开其他地址后，origin fetch、不同的 origin push 和 upstream fetch 均展示名称及地址；同地址独立 base 的配置分开显示，见[其他地址](evidence/2026-10-22-git-address/other-addresses.jpg)。 |
| 按需详情 | 点击 payment-independent 行，详情显示该独立 clone 的远程及其自身 `.git` common-dir，没有引用 main base 的状态，见[base 详情](evidence/2026-10-22-git-address/base-detail.jpg)。 |
| 筛选与全局统计 | 筛选未知后仅显示 main base 下的缺失登记，全局统计仍为 5 / 2 / 2 / 1；恢复全部后五项重新展示。见[未知筛选](evidence/2026-10-22-git-address/unknown-filter.jpg)。 |

浏览器控制台没有 error 记录。验收完成后，本地用户验证服务 `http://127.0.0.1:43110` 已以本轮构建重启，`GET /health` 返回 `{"ok":true}`，Web 页面 HTTP 200；用户原标签页保留，刷新后可重新打开原工作区验证。

### 10.3 边界

- 地址分类依据本地 Git 配置，不联网解析或猜测不同 SSH/HTTPS 写法是否指向同一远程；相同展示地址也不代表共享同一个本地 base。
- 本轮浏览器使用展示用远程地址，没有触发远程同步；地址读取本身不修改 Git 配置或工作目录。
- P12 实际 Worktree 移除仍为后续阶段，本轮仅改善归属展示。
