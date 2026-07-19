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
- HEAD、暂存区和工作区 Diff
- Git 历史分页、提交详情和提交文件 Diff
- UTF-8、二进制、大文件和路径安全保护

## 环境

- Node.js 22+
- npm 10+
- Git 2.30+
- Linux 或 macOS

## 开发运行

```bash
npm install
npm run dev
```

- Web 开发地址：`http://127.0.0.1:4312`
- API 地址：`http://127.0.0.1:4311`

## 生产运行

```bash
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:4311`。

## 验证

```bash
npm run check
```

该命令依次执行类型检查、自动化测试和生产构建。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `4311` | 服务端口 |
| `FILE_WARN_BYTES` | `2097152` | 大文件警告阈值 |
| `FILE_READONLY_BYTES` | `10485760` | 只读阈值 |
| `GIT_TIMEOUT_MS` | `10000` | Git 查询超时 |
| `GIT_MAX_OUTPUT_BYTES` | `52428800` | Git 输出上限 |
| `WATCH_DEBOUNCE_MS` | `250` | Git 状态刷新防抖 |
| `APP_PASSWORD` | 无 | 必填的全局访问密码，可放在未提交的 `.env` 中 |

## 安全边界

- 默认只监听本机地址。
- 文件 API 只接受当前工作区的相对路径。
- `.git` 目录不能通过文件 API 访问。
- 指向工作区外的符号链接不能被打开。
- Git 命令不经过 shell，前端不能提交任意 Git 参数。
- Git 功能为只读，不包含 stage、commit、discard、push 或 pull。

## 当前产品边界

- 单活动工作区。
- 文本编辑以 UTF-8 为主。
- 大于默认 10 MiB 的文件不加载到 Monaco。
- Merge Commit 默认与第一父提交比较。
- 不包含远程部署认证；如修改 `HOST` 对外监听，需要另行增加认证和 TLS。

设计与实施资料见 [docs/detailed-design.md](docs/detailed-design.md)、[docs/task-plan.md](docs/task-plan.md) 和 [docs/acceptance-report.md](docs/acceptance-report.md)。
