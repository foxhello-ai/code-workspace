# Code Workspace

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
- 按 Git 地址分类的 worktree 总览，保留各 common-dir base、多远程地址、全局统计、主/当前标识、修改优先排序及按需详情
- 只读清理预览及 worktree 根目录删除/重命名保护
- HEAD、暂存区和工作区 Diff
- Git 历史分页、提交详情和提交文件 Diff
- UTF-8、二进制、大文件和路径安全保护

## 环境

- Node.js 22+
- npm 10+
- Git 2.39+（worktree 登记使用 porcelain NUL 格式；本次验证为 2.40.0）
- Linux 或 macOS

## 开发运行

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

macOS 或 Linux 可直接安装最新 GitHub Release。脚本会校验发布包、生成随机访问密码并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

安装完成后访问 `http://127.0.0.1:43110`。完整的前置条件、升级、配置与服务管理说明见 [安装文档](docs/installation.md)。

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

PM2 配置位于 `ecosystem.config.cjs`，服务异常退出后会自动重启，并固定监听 `0.0.0.0:43110`。

## 验证

```bash
npm run check
```

该命令依次执行类型检查、自动化测试和生产构建。

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
| `APP_PASSWORD` | `fmzh2026` | 全局访问密码，可通过环境变量或未提交的 `.env` 覆盖 |

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

B-009 与 B-010 阶段 A 已实现，需求与追溯见[子工作区 Git 需求](docs/change-request-subworkspace-git.md#11-2026-10-22-扩展需求基线)、[专项计划 P7～P11](docs/subworkspace-git-development-plan.md#4-2026-10-22-扩展实施计划)及[本次验收](docs/acceptance-report.md#8-远程提交图与-worktree-扩展验收)。P12 的实际 worktree 移除按计划单列后续阶段，当前仅提供只读预览。

进入“Git 历史”点击“同步远程”取得新提交，切换历史范围无需 checkout。点击“Worktree 关系图”可查看各目录状态、过滤干净/有修改项、定位提交和检查清理条件。“文件干净”与“提交已发布”分别展示；所有远程指标只代表已获取的本地引用。未配置 upstream、默认分支未知、浅仓库和查询失败均有明确提示。

同步结果仅保存在服务进程内；重启后显示尚未同步。Git 元数据监听仅覆盖必要的 refs、登记、HEAD/index，初始超过 5000 项时明确降级为手动刷新；不监听其他 worktree 的全部源码。清理预览的活跃会话信息来自浏览器 15 秒心跳（45 秒有效），无法判断外部程序占用。

本地浏览器验收样例可用 `node scripts/create-git-acceptance-fixture.mjs` 创建，脚本只建立临时 bare remote、两个 clone、关联 worktree 和 200 条以上历史，输出可打开的工作区路径。
