# Code Workspace MVP 验收报告

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
