# Code Workspace

简体中文 | [English](README.en.md)

一个本地优先的轻量代码工作区，提供文件树、Monaco 编辑、Git 状态与历史、Git Diff，以及外部文件变化同步。

它不会启动终端、Codex 会话或 AI 服务。外部工具只作为工作区文件的修改者存在。

## 功能

- 单本地工作区打开与关闭
- 懒加载文件树及 Git 状态标识
- 文件新建、文件夹新建、重命名和删除
- Monaco 多标签文本编辑
- 基于内容版本的安全保存和 `409` 冲突保护
- 外部新增、修改、删除和目录变化实时同步
- 编辑器缓冲区与磁盘内容冲突 Diff
- Git staged、unstaged、untracked、conflict 分类
- 本地及远程分支查看与受保护切换
- 受控远程 fetch、各远程同步结果；按共享仓库合并重复同步
- 全分支 Commit Graph、分叉、合并、Tag 与 refs 展示
- Git 历史全屏、本地 HEAD 定位、领先/落后及本地/远程提交归属标记
- 图和列表统一全部/当前 worktree/指定引用范围，版本化分页和加载进度
- 按 Git 地址与本地仓库分组的 Worktree 总览，支持目录/分支搜索、仓库筛选、全局统计及内联详情
- 只读清理预览及 worktree 根目录删除/重命名保护
- HEAD、暂存区和工作区 Diff
- Git 历史分页、提交详情和提交文件 Diff
- 独立 Git 工作台，分类文件差异与提交图内联查看，切换模块保留查看位置
- UTF-8、二进制、大文件和路径安全保护

## 环境

- Node.js 22+
- npm 10+（仅开发与打包需要，脚本安装无需 npm）
- Git 2.39+（worktree 登记使用 porcelain NUL 格式；本次验证为 2.40.0）
- Linux、macOS，或 Windows 11 x64（PowerShell 5.1+）

## 开发运行

启动前将 `.env.example` 复制为未提交的 `.env`，设置随机的 `APP_PASSWORD`。生产环境没有默认密码，缺少配置会拒绝启动；脚本安装会自动生成密码。

```bash
npm install
npm run dev
```

- Web 开发地址：`http://localhost:4312`
- API 地址：`http://127.0.0.1:43110`

## 生产运行

```bash
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:43110`。

## 快速安装

三个平台都通过脚本安装编译好的 GitHub Release，校验 SHA-256、生成随机访问密码并在后台启动服务；安装用户无需克隆源码、安装 npm 依赖或执行构建。本机需先有 Node.js 22+ 和 Git 2.39+。

**macOS / Linux：**

```bash
curl --http1.1 -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

**Windows 11 x64（在 PowerShell 中执行）：**

```powershell
irm https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.ps1 | iex
```

Windows 如未安装运行环境，可先通过 `winget install --id OpenJS.NodeJS.LTS -e` 和 `winget install --id Git.Git -e` 安装，然后重新打开 PowerShell。无需 WSL、Git Bash 或管理员权限来安装 Code Workspace。

安装完成后访问 `http://127.0.0.1:43110`。完整的前置条件、升级、配置与服务管理说明见 [安装文档](docs/installation.md)。

发布包已包含编译产物和对应平台的生产依赖；macOS/Linux 还需 `curl`、`tar` 和 SHA-256 校验工具，Windows 使用系统 PowerShell 的下载、解压及校验功能。安装命令取得的是 **Latest Release**。`main`、PR 和手动触发会运行三个系统的验证，只有与 `package.json` 版本一致的 `v*` 标签会发布安装包。

安装后可检查服务：

```bash
~/.local/bin/code-workspace status
curl -fsS http://127.0.0.1:43110/health
```

健康检查应返回 `{"ok":true}`。访问密码由安装脚本随机生成，保存在 `~/.config/code-workspace/config.env`。

Windows 安装后可直接运行 `code-workspace status`；通用管理命令为 `code-workspace start|status|logs|restart|stop`。Windows 配置保存在 `$env:LOCALAPPDATA\CodeWorkspace\config\config.json`，日志位于同一安装目录的 `state\server.log`。在页面输入 `D:\projects\my-project` 等 Windows 路径打开工作区。

旧版 Windows 安装脚本若在 `Set-Acl` 处报缺少 `SeSecurityPrivilege`，请在同一账户下重新执行上面的在线安装命令。修复后的脚本只更新访问权限，无需管理员或审计特权，并保留已有配置和密码；安装指定版本时同样生效。详见[安装文档](docs/installation.md)。

重新执行安装命令会保留配置和密码，停止原安装服务后启动所选版本；旧版本目录保留。升级会重启服务，请先保存编辑内容。

### PM2 持久运行

```bash
npm run build
npm run pm2:start
npx pm2 save
```

常用命令：

```bash
npm run pm2:restart
npm run pm2:stop
npm run pm2:logs
npx pm2 status
```

PM2 配置位于 `ecosystem.config.cjs`，服务异常退出后会自动重启，默认仅监听 `127.0.0.1:43110`。

## Git 与 Worktree 更新

### 完整提交历史与本地、远程差异

1. 进入 **Git → 提交历史**，点击 **获取远程**，获取当前本地仓库各已配置远程的新分支和提交。**刷新状态**只重读本地快照。
2. 在提交图或列表中选择 **全部 / 当前 worktree / 指定引用**，按需加载更多提交；切换查看范围无需 checkout。
3. 点击全屏按钮扩大历史视图，按 `Esc` 或退出按钮返回；范围、已加载记录和选中项保留。
4. 根据醒目的 **本地 HEAD**、本地/远程提交归属和 upstream 领先/落后数量，确认本地与远程的差别。选中提交可查看文件列表，逐文件或全部 Diff 在提交图下方展开。
5. **工作区修改**按冲突、已暂存、未暂存和未跟踪分类；选择文件直接查看统一或并排差异，同一文件的暂存区和工作目录分别比较。切换 Git 标签或 Worktree 模块后，保留文件选择、历史范围和已加载记录。

所有远程指标只代表已获取的本地引用；未配置 upstream、浅仓库和查询失败会保留未知状态。获取结果仅保存在服务进程内，重启后显示尚未获取远程。

### 按 Git 地址查看 Worktree 归属

- 顶部汇总全部 Worktree 的数量，以及修改、干净、未知数量；筛选不改变全局统计。
- 按 **Git 远程地址 → 本地仓库（common-dir）→ Worktree** 分组。同一地址的独立 clone 各自显示为一个本地仓库，以名称和路径区分；各自包含主工作区及关联 Worktree。完整地址和目录信息可展开查看。
- 主地址优先使用 `origin` 的首个 fetch URL；其他 fetch/push 地址可展开查看。URL 凭证不显示，未配置远程或读取失败分别提示。
- 支持侧栏仓库筛选与目录/分支搜索；分类及本地仓库修改优先，仓库内按 **修改 → 干净 → 未知** 排序；紧凑行展示分支、文件状态及未发布提交数，点击后在右侧查看详情，窄屏下自动改为上下布局。
- **主工作区** 和 **当前项** 有独立标识；详情可定位提交图、查看独立修改或打开只读清理预览。

“文件干净”与“提交已发布”分别展示。当前只提供清理预览和 Worktree 根目录保护，实际移除仍为后续阶段；不同 SSH/HTTPS 地址写法不会自动合并为同一远程。

界面示例：[Worktree 总览与详情](docs/evidence/2026-10-29-workbench/worktree.png)、[工作区修改](docs/evidence/2026-10-29-workbench/changes.png)、[提交历史](docs/evidence/2026-10-29-workbench/history.png)、[窄屏布局](docs/evidence/2026-10-29-workbench/worktree-mobile.png)。

### 打开工作区时的加载

目录存在且可读取时，立即进入工作区界面，先加载文件树；Git 仓库扫描、Worktree 登记、文件监听和变更统计在后台完成。文件可先查看和编辑，Git / Worktree 页面显示当前加载阶段，完成后自动更新。加载失败可原地重试，保留已打开的文件；加载中也可切换工作区。Git 信息就绪前，重命名和删除暂不可用，以保护 Worktree 根目录。

### 外网加载与静态资源缓存

登录入口只加载登录与鉴权代码，登录后再加载工作区；首次编辑文件或查看文本差异时才加载 Monaco 和语言 Worker。HTML 内置加载画面，模块下载时显示等待状态，下载失败提供重新加载入口。

生产构建会生成 JS / CSS 的 Brotli 与 gzip 版本，服务根据浏览器能力返回压缩资源。带哈希的静态资源使用 `public, max-age=31536000, immutable`，HTML 使用 `no-cache`，API 使用 `no-store`。Cloudflare 缓存规则应尊重这些响应头，缓存范围限定于公开静态资源；API 和 WebSocket 保持回源。

外网前后采样、缓存命中及回归结果见[加载优化验收](docs/evidence/2026-10-29-web-load/README.md)。

## 验证

```bash
npm run check
```

该命令依次执行类型检查、自动化测试和生产构建。

发布安装验证（首次安装、重复安装、升级后实际运行版本、校验失败及生产包登录/Git API）可执行：

```bash
npm run package:release
CODE_WORKSPACE_TEST_ARCHIVE="release/code-workspace-$(node -p 'require("./package.json").version').tar.gz" node --test scripts/install.test.mjs scripts/service-manager.test.mjs
```

Windows 发布 ZIP 的验证命令见[安装文档](docs/installation.md)。同一检查在 Linux、macOS、Windows 发布任务中执行，全部通过后才公开安装包。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `43110` | 服务端口 |
| `FILE_WARN_BYTES` | `2097152` | 大文件警告阈值 |
| `FILE_READONLY_BYTES` | `10485760` | 只读阈值 |
| `GIT_TIMEOUT_MS` | `10000` | Git 查询超时 |
| `GIT_FETCH_TIMEOUT_MS` | `60000` | 每个远程同步命令超时，非交互认证 |
| `GIT_WORKTREE_LIMIT` | `200` | 每个共享仓库最多读取的登记项；超限明确显示部分结果 |
| `GIT_STATUS_LIMIT` | `40` | 每次总览最多查询的 worktree 状态，最多并发 4 项；其余显示未知 |
| `GIT_MAX_OUTPUT_BYTES` | `52428800` | Git 输出上限 |
| `GIT_DISCOVERY_DEPTH` | `1` | Git 子仓库发现深度，`0` 只检测根目录，`1` 检测一级，`2` 检测二级 |
| `GIT_DISCOVERY_MAX_DIRS` | `200` | Git 仓库发现最多检查目录数 |
| `GIT_DISCOVERY_TIMEOUT_MS` | `5000` | Git 仓库发现总超时 |
| `WATCH_DEBOUNCE_MS` | `250` | Git 状态刷新防抖 |
| `WATCH_MAX_FILES` | `5000` | 文件监听最大条目数，超过后自动关闭实时监听以保护 Git 查询 |
| `APP_PASSWORD` | 必填，无默认值 | 通过环境变量或未提交的 `.env` 配置；安装脚本自动生成随机密码 |

## 安全边界

- 默认只监听本机地址。
- 文件 API 只接受当前工作区的相对路径。
- `.git` 目录不能通过文件 API 访问。
- 工作区内的符号链接会按目标类型展示为文件或文件夹；路径仍必须从工作区相对路径进入。
- Git 命令不经过 shell，前端不能提交任意 Git 参数。
- Git 支持显式 fetch 和受保护的分支切换；不包含 stage、commit、discard、push 或 pull。
- fetch 从已配置远程取得全部 heads 与 tags，不修改持久化 refspec，不删除本地分支或 Tag；普通刷新仅重读本地快照。
- 工作区外新登记的 worktree 只读展示，不扩展文件或分支操作权限。

## 当前产品边界

- 单活动工作区。
- 文本编辑以 UTF-8 为主。
- 大于默认 10 MiB 的文件不加载到 Monaco。
- Merge Commit 默认与第一父提交比较。
- 不包含远程部署认证；如修改 `HOST` 对外监听，需要另行增加认证和 TLS。

设计与实施资料见 [docs/detailed-design.md](docs/detailed-design.md)、[docs/task-plan.md](docs/task-plan.md)、[docs/acceptance-report.md](docs/acceptance-report.md) 和 [docs/backlog.md](docs/backlog.md)。

公开仓库的敏感信息处理与历史清理说明见 [安全说明](docs/security-cleanup.md)。

B-009 与 B-010 阶段 A、P13/P14 的界面优化已实现，需求与追溯见[子工作区 Git 需求](docs/change-request-subworkspace-git.md#11-2026-10-22-扩展需求基线)、[专项计划](docs/subworkspace-git-development-plan.md#4-2026-10-22-扩展实施计划)及[验收报告第 8～10 节](docs/acceptance-report.md#8-远程提交图与-worktree-扩展验收)。

Git 元数据监听仅覆盖必要的 refs、登记、HEAD/index，初始超过 5000 项时明确降级为手动刷新；不监听其他 Worktree 的全部源码。清理预览的活跃会话信息来自浏览器 15 秒心跳（45 秒有效），无法判断外部程序占用。

本地浏览器验收样例可用 `node scripts/create-git-acceptance-fixture.mjs` 创建，脚本只建立临时 bare remote、两个 clone、关联 worktree 和 200 条以上历史，输出可打开的工作区路径。
