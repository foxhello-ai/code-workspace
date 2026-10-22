# 集成终端能力变更需求

## 1. 背景

当前 `Code Workspace` 已支持打开本地工作区、浏览文件、编辑文本、查看 Git 修改、历史和 Diff。用户在处理本地项目时，常常还需要进入同一目录执行命令，例如：

- 查看当前目录内容、运行脚本或构建命令。
- 在当前 Git 仓库根目录执行 `git`、`npm`、`mvn` 等命令。
- 复制文件路径后到终端中进一步处理。
- 在多个子仓库工作区中快速打开对应项目的命令行环境。

现有产品边界明确写明“不启动终端、Codex 会话或 AI 服务”。如果要支持终端，需要作为新的受控能力进入变更范围，不能简单复用 GitRunner 或文件 API 混入实现。

## 2. 现状审核

### 2.1 已具备基础

- 后端基于 Fastify，已接入 `@fastify/websocket`，具备 WebSocket 通道基础。
- 前端已使用 React、Zustand、TanStack Query，能够承载独立 UI 状态。
- 当前浏览器 Tab 已通过 `x-code-workspace-session` 做工作区会话隔离。
- 服务端已有工作区、Git 仓库、文件树和绝对路径解析能力，可以为终端提供初始工作目录。
- PM2 已作为固定运行方式，适合管理长期运行的 Node 服务。

### 2.2 当前缺口

- 没有 PTY 进程管理能力，普通 `spawn` 无法提供完整交互式终端体验。
- 没有终端输入、输出、resize、关闭、重连的协议。
- 没有终端进程生命周期管理，工作区关闭或浏览器断开后无法清理 shell。
- 没有终端安全开关和资源限制。
- 前端没有终端渲染组件和底部面板/标签页入口。
- 现有 `README`、`task-plan`、`detailed-design` 均把终端列为非目标，后续实施时需要同步更新产品边界文档。

## 3. 是否能支持

结论：可以支持，但必须按“显式启用的本机 PTY 终端”实现。

原因：

- 浏览器内真实终端需要后端维护本机 shell 进程，并把输入输出通过 WebSocket 转发。
- 当前项目的 WebSocket、会话隔离、认证和 PM2 运行方式可以承接该能力。
- 终端本质上是任意本机命令执行入口，安全等级明显高于文件编辑和 Git 只读查询，必须默认关闭并加入准入检查。

不建议用现有 `GitRunner` 扩展成终端。`GitRunner` 适合受控 Git 命令：参数由服务端白名单构造、禁用 shell、输出有上限。终端需要交互式 shell、伪终端、实时输入输出和窗口尺寸同步，两者模型不同。

## 4. 技术选型

### 4.1 推荐方案

| 层级 | 推荐使用 | 说明 |
|---|---|---|
| 前端终端渲染 | `@xterm/xterm` | 浏览器内终端渲染，支持 ANSI、输入、选择、复制等基础能力。 |
| 前端自适应 | `@xterm/addon-fit` | 终端面板 resize 后自动计算 rows/cols。 |
| 前端链接识别 | `@xterm/addon-web-links` | 可选，用于识别输出中的 URL。 |
| 后端 PTY | `node-pty` | 在 Node.js 中创建伪终端，适合交互式 shell。 |
| 通信通道 | Fastify WebSocket | 复用现有 `@fastify/websocket`，新增独立终端通道。 |
| Shell | `TERMINAL_SHELL` 或系统默认 shell | macOS 默认可使用 `/bin/zsh`，Linux 默认可使用 `/bin/bash` 或 `/bin/sh`。 |

截至本次调研，npm 包版本参考：

- `@xterm/xterm`: `6.0.0`
- `@xterm/addon-fit`: `0.11.0`
- `node-pty`: `1.1.0`

实际开发前需要在当前 Node.js 22 环境中执行一次依赖安装和构建验证，因为 `node-pty` 包含原生模块，macOS 上可能依赖 Xcode Command Line Tools。

### 4.2 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| `spawn` + WebSocket | 不推荐作为终端 | 无法稳定支持交互式 TTY、全屏程序、颜色、控制字符和 resize。 |
| 只做命令运行器 | 可作为后续安全模式 | 适合白名单命令，不是用户期望的完整 terminal。 |
| 调起系统外部 Terminal | 不推荐首选 | Web 服务很难可靠控制本机 GUI，且移动端/远程浏览器不可用。 |
| 容器化终端 | P2 可评估 | 安全边界更强，但引入 Docker/容器运行依赖，超出轻量本地工作区定位。 |

## 5. 需求完善

### 5.1 功能目标

在当前工作区内提供集成终端能力，用户可以从浏览器中打开一个或多个终端会话，并在选定目录中执行本机命令。

必须支持：

- 打开终端面板。
- 新建终端会话。
- 关闭终端会话。
- 在当前工作区根目录启动终端。
- 在当前 Git 仓库根目录启动终端。
- 从文件树目录右键“在终端中打开”。
- 展示终端当前初始路径、所属工作区、所属浏览器 Tab session。
- 支持输入、输出、复制、粘贴和窗口 resize。
- 工作区关闭、用户退出登录、服务关闭时清理终端进程。

### 5.2 UI 入口

建议新增底部终端面板，而不是放入左侧 Git/文件侧栏。

原因：

- 终端输出通常横向内容较多，侧栏空间不足。
- 底部面板符合代码编辑器用户预期。
- 可与编辑区共享宽度，减少命令输出换行。

建议交互：

- 顶部栏或状态栏增加终端按钮。
- 编辑区底部增加可拉伸终端面板。
- 终端面板支持多个终端标签。
- 文件树目录右键菜单增加“在终端中打开”。
- Git 项目下拉或 Git 面板中增加“在当前仓库打开终端”。

### 5.3 会话模型

新增终端会话模型：

```ts
interface TerminalSessionInfo {
  id: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  cwd: string;
  shell: string;
  createdAt: string;
  lastActiveAt: string;
  exited: boolean;
  exitCode?: number;
}
```

会话规则：

- 终端会话必须绑定当前浏览器 Tab 的 `sessionId`。
- Tab A 创建的终端不能被 Tab B 访问。
- 工作区关闭时，关闭该工作区下所有终端。
- 服务重启后终端进程不会恢复，前端应显示“终端会话已结束”。
- WebSocket 断线后，如果后端进程仍存在，允许原 Tab reconnect 到同一个 terminalId。
- 每个 Tab 默认最多同时运行 4 个终端，可通过配置调整。

### 5.4 初始工作目录

终端创建时支持以下初始目录：

| 来源 | 初始 cwd |
|---|---|
| 工作区终端 | 当前工作区根目录 |
| Git 项目终端 | 当前选中 Git 仓库真实根目录 |
| 文件树目录右键 | 该目录对应的后端校验后绝对路径 |
| 文件树文件右键 | 文件所在目录对应的后端校验后绝对路径 |

注意：PathGuard 只能校验终端启动时的初始目录。终端启动后，用户在 shell 内执行 `cd /`、访问其他路径或运行任意命令，属于本机 shell 权限范围，无法用现有文件 API 的路径边界约束。如果需要强隔离，必须另做容器或受限 shell 方案。

### 5.5 通信协议

建议新增 HTTP API：

```text
GET    /api/terminals
POST   /api/terminals
DELETE /api/terminals/:terminalId
```

建议新增 WebSocket：

```text
GET /api/terminals/:terminalId/socket?sessionId=
```

WebSocket 消息建议：

```ts
type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

type TerminalServerMessage =
  | { type: "ready"; terminal: TerminalSessionInfo }
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };
```

### 5.6 配置项

建议新增配置：

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `TERMINAL_ENABLED` | `false` | 是否启用集成终端。默认关闭。 |
| `TERMINAL_SHELL` | 空 | 指定 shell。为空时按系统选择默认 shell。 |
| `TERMINAL_MAX_SESSIONS` | `4` | 每个浏览器 Tab 最多同时运行的终端数。 |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | 终端无连接后的保留时间，默认 30 分钟。 |
| `TERMINAL_OUTPUT_BUFFER_BYTES` | `1048576` | 断线重连时最多保留的输出缓冲。 |
| `TERMINAL_STARTUP_TIMEOUT_MS` | `5000` | PTY 启动超时。 |

安全准入建议：

- 当 `TERMINAL_ENABLED=true` 时，禁止继续使用默认 `APP_PASSWORD=fmzh2026`。
- 当服务监听 `0.0.0.0` 且终端启用时，启动日志必须输出高风险提醒。
- 后续如提供设置页，终端开启状态必须在 UI 明显展示。

### 5.7 安全要求

终端能力代表“远程执行当前系统用户权限下的任意命令”。必须明确以下限制：

- 默认关闭，需要用户通过环境变量显式开启。
- 需要登录后才能访问终端 API 和 WebSocket。
- 终端会话按浏览器 Tab session 隔离。
- 后端只能从已打开的工作区或已校验路径创建初始 cwd。
- 不允许前端传入任意 shell 可执行文件路径，除非在服务端配置中显式允许。
- 不记录完整终端输入输出，避免泄露密码、token 和业务数据。
- 可以记录生命周期审计：创建、关闭、退出、初始 cwd、shell、sessionId、workspaceId。
- 关闭工作区、退出登录、session 空闲超时、服务关闭时必须 kill PTY。
- 限制并发终端数量和输出缓冲，避免资源耗尽。

### 5.8 非目标

本次变更不做：

- Codex 会话、AI 任务、AI 命令建议或自动执行。
- 远程 SSH 管理、端口转发、SFTP。
- sudo 密码托管或系统权限提升。
- 容器沙箱、chroot 或虚拟机隔离。
- 多用户权限体系。
- 终端内容持久化历史。
- 命令审计回放。
- 在移动端提供完整终端操作体验。

### 5.9 移动端策略

移动端可以查看终端面板入口和终端状态，但不作为首批完整体验目标。

建议：

- 窄屏下终端面板以全屏抽屉方式打开。
- 默认不自动聚焦键盘。
- 保留复制输出和关闭终端能力。
- 不承诺复杂全屏 TUI 程序在移动端可用。

## 6. 影响范围

### 6.1 后端

- `src/server/config.ts`：增加终端配置项。
- `src/shared/contracts.ts`：增加终端会话和 WebSocket 消息类型。
- `src/server/services/terminal-service.ts`：新增 PTY 会话管理。
- `src/server/app.ts`：新增终端 HTTP API 和 WebSocket 路由。
- `src/server/security/path-guard.ts`：复用现有路径校验获取初始 cwd。
- `src/server/app.test.ts`：增加终端关闭、权限、配置关闭、session 隔离测试。

### 6.2 前端

- `package.json`：增加 `@xterm/xterm`、`@xterm/addon-fit`、可选 `@xterm/addon-web-links`。
- `src/web/api.ts`：增加终端 API。
- `src/web/store.ts`：增加终端面板状态和终端标签状态。
- `src/web/App.tsx`：增加终端面板、终端标签、文件树右键入口。
- `src/web/styles.css`：增加底部面板、终端 resize、终端标签样式。

### 6.3 文档

实施时需要同步更新：

- `README.md`：移除“不启动终端”的旧边界，改为“终端默认关闭，可配置启用”。
- `docs/detailed-design.md`：新增终端架构和安全边界。
- `docs/task-plan.md`：新增终端里程碑。
- `docs/acceptance-report.md`：新增终端验收记录。

## 7. 推荐实施拆分

### P1：基础 PTY 终端

- 增加配置项，默认关闭。
- 接入 `node-pty`。
- 新增 `TerminalService`。
- 新增创建、列表、关闭终端 API。
- 新增终端 WebSocket 输入输出和 resize。
- 前端接入 `@xterm/xterm` 和 `@xterm/addon-fit`。
- 支持工作区根目录打开终端。

### P2：工作区集成

- 文件树目录右键增加“在终端中打开”。
- Git 项目入口增加“在当前仓库打开终端”。
- 底部终端面板支持多终端标签。
- 支持面板拖拽调整高度。
- 工作区关闭、退出登录时清理终端。

### P3：可靠性与安全硬化

- session 隔离测试。
- 终端数量上限和 idle timeout。
- WebSocket 重连和输出缓冲。
- PM2 关闭时终端进程清理。
- 启用终端时检查默认密码风险。
- 输出过大、异常退出、shell 不存在的错误提示。

### P4：体验增强

- 终端标题自动更新。
- 搜索、链接识别、清屏按钮。
- 从编辑器当前文件所在目录打开终端。
- 窄屏终端抽屉。

## 8. 验收标准

### 8.1 配置关闭

- 默认配置下访问终端 API 返回明确错误，例如“终端能力未启用”。
- 默认配置下前端不展示可用终端入口，或展示禁用态和原因。

### 8.2 基础终端

- 设置 `TERMINAL_ENABLED=true` 后可以打开终端。
- 终端启动在当前工作区根目录。
- 输入 `pwd` 显示的目录与工作区根目录一致。
- 输入、输出、复制、粘贴、resize 正常。
- 关闭终端后后端 PTY 进程退出。

### 8.3 多会话隔离

- 同一浏览器 Tab 可打开多个终端。
- 不同浏览器 Tab 的终端列表互不展示。
- Tab A 无法通过 terminalId 连接 Tab B 的终端。
- 切换工作区后旧工作区终端被关闭。

### 8.4 文件树与 Git 集成

- 对文件夹右键“在终端中打开”后，终端 cwd 为该文件夹绝对路径。
- 对文件右键“在终端中打开”后，终端 cwd 为该文件所在目录。
- 在 Git 项目入口打开终端后，cwd 为当前 Git 仓库根目录。
- symlink 文件夹作为初始 cwd 时，路径必须经过后端校验。

### 8.5 安全与资源

- 未登录时不能访问终端 API 和 WebSocket。
- `TERMINAL_MAX_SESSIONS` 生效，超过限制时返回明确错误。
- shell 路径不存在时返回明确错误。
- 终端无连接超过 idle timeout 后被回收。
- PM2 restart 后前端显示原终端已结束，不出现无限加载。

## 9. 风险与处理

| 风险 | 影响 | 处理 |
|---|---|---|
| 任意命令执行 | 高安全风险 | 默认关闭；启用时要求非默认密码；限制为已登录用户；文档明确风险。 |
| `node-pty` 原生模块安装失败 | 构建失败 | 开发前验证 Node 22、macOS、Linux；必要时评估 `@lydell/node-pty`。 |
| 终端进程泄漏 | 系统资源耗尽 | 工作区关闭、断线超时、服务关闭统一 kill。 |
| 输出过大 | 内存增长 | 限制断线缓冲大小，实时输出不全量持久化。 |
| Tab 间串会话 | 用户误操作或信息泄露 | terminalId 绑定 sessionId 和 workspaceId，服务端强校验。 |
| 远程暴露服务 | 远程命令执行风险 | 继续建议本机访问；监听 `0.0.0.0` 时输出高风险提醒。 |
| 移动端输入体验差 | 可用性不稳定 | 首期不承诺完整移动端终端体验，窄屏使用全屏抽屉。 |

## 10. 审核结论

审核通过，但必须按受控增强实施：

- 技术方案采用 `@xterm/xterm` + `@xterm/addon-fit` + `node-pty` + Fastify WebSocket。
- 终端默认关闭，通过 `TERMINAL_ENABLED=true` 显式启用。
- 启用终端时必须要求非默认访问密码。
- 终端会话必须按浏览器 Tab session 和 workspaceId 隔离。
- 首期只做本机 PTY 终端，不做 Codex、AI、SSH、sudo 托管和容器沙箱。

该能力建议作为新的独立版本能力实现，不与文件编辑、Git 受控展示或历史 Diff 优化混在同一个提交中。

## 11. 参考资料

- xterm.js 官方站点：https://xtermjs.org/
- xterm.js 文档：https://xtermjs.org/docs/
- xterm.js GitHub：https://github.com/xtermjs/xterm.js
- node-pty GitHub：https://github.com/microsoft/node-pty
- npm `@xterm/xterm`：https://www.npmjs.com/package/@xterm/xterm
- npm `node-pty`：https://www.npmjs.com/package/node-pty
