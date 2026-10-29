# workspace.foxhello.cn 网页加载优化

2026-10-29。已在本地 43110 服务生效，并从 https://workspace.foxhello.cn/ 完成 HTTPS 验收。

## 说明原因

原入口直接导入工作区、Monaco 和语言 Worker 的初始化代码，登录前就请求 3,639,268 字节的 JS 和 180,067 字节的 CSS。外网压缩传输仍合计 1,009,081 字节。HTML 的 root 原本为空，首屏需要等待脚本及样式。Cloudflare 上的 JS/CSS 缓存响应为 4 小时，基线观察到 REVALIDATED。

## 当前代码问题点

React 登录状态判断只决定渲染哪个界面，无法阻止静态 import 下载编辑器；Monaco 的样式也进入登录首屏。静态服务使用默认缓存策略，缺少针对哈希资源和动态 API 的明确区分。

## 代码错误位置

- `src/web/main.tsx`：原先静态导入 Monaco、编辑器/语言 Worker 与整个 App。
- `src/web/App.tsx`：原先将登录、工作区、Editor 静态依赖放在同一加载链路。
- `src/web/DiffViewer.tsx`：原先直接依赖 Monaco 的 React 包。
- `src/web/index.html`：原 root 空白。
- `src/server/app.ts`：原静态资源未区分 HTML、哈希资源与缺失资源。

## 修改方案

1. 登录入口只依赖 React、鉴权 API、表单和少量图标。鉴权成功后动态加载工作区与其 CSS。
2. 首次编辑文件或查看文本差异时，才动态加载 Monaco 运行时和 CSS；语言 Worker 保持同源本地打包。加载中显示提示，失败提供重新加载入口。
3. HTML 内联基础样式、应用名称与加载状态，JS 阻塞时也可显示。表单样式同样内联，登录页没有额外 CSS 请求。
4. JS/CSS 在生产构建时生成 Brotli、gzip 文件，静态服务协商编码并返回 Vary。
5. 哈希资源使用 `public, max-age=31536000, immutable`；HTML 使用 `no-cache`；API 使用 `no-store`。缺失的 assets 返回不缓存的 404，避免将 HTML 当成 JS。

## 修改的代码点

- `AuthGate.tsx`、`WorkspaceRoot.tsx`、`main.tsx`：鉴权边界、工作区动态加载、查询状态清理。
- `CodeEditor.tsx`、`DiffViewer.tsx`、`EditorRuntime.tsx`：编辑器与 Diff 共用延迟运行时，保留本地 Worker 和原模型释放顺序。
- `LoadingBoundary.tsx`、`index.html`：HTML 加载画面及模块加载/失败提示。
- `app.ts`：缓存、压缩协商、缺失资源响应。
- `vite.config.ts`：仅生产构建执行预压缩。
- `AuthGate.test.tsx`、`static-assets.test.ts`：鉴权后加载、鉴权重试、缓存/压缩/404/API 私密数据等行为。

## 外网测量

[对比汇总](comparison.json)、[优化前](baseline.json)、[优化后首次](after.json)、[后续两轮](after-repeat.json)、[第三轮](after-third.json)。每次使用新浏览器上下文，浏览器缓存为空；服务/Cloudflare 状态和网络链路会变化。优化前只有一轮，耗时对比仅用于描述本机采样，不代表大陆多地区性能承诺。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 登录入口 JS 原始体积 | 3.64 MB | 202 KB |
| 登录首屏 JS + CSS 压缩传输 | 1,009 KB | 61 KB（减少约 94%） |
| 首次可见内容 FCP | 6.46 s | 1.58 / 4.41 / 3.66 s |
| 登录表单可用 | 8.41 s | 4.68 / 7.50 / 5.84 s |
| 外网资源 Cache-Control | max-age=14400 | max-age=31536000, immutable |
| Cloudflare 资产状态 | REVALIDATED | MISS → HIT → HIT |

Monaco JS 约 3.32 MB，Brotli 后约 762 KB，工作区 JS 约 114 KB、Brotli 后约 32 KB；两者均从登录首屏移出。编辑器首次使用仍需下载自身资源。

[公开资产头](asset-headers.txt) 确认一年缓存、HIT 和 Age；[鉴权 API 头](api-headers.txt) 确认 no-store / DYNAMIC。本次通过源站响应头使现有 Cloudflare 规则接收缓存，没有修改 Cloudflare 控制台规则，也没有迁移 CDN。

## 验证方式

- `npm run check` 通过：类型检查、78 项测试（14 个文件）、生产构建。最终加载画面居中调整另经构建和截图检查；构建仍提示延迟 Monaco chunk 超过 500 KB。
- [本地 Chrome 验收](acceptance.json)：阻塞入口脚本仍显示 HTML 内容；登录前只下载入口 JS；鉴权后工作区不下载 Monaco；首次编辑延迟加载；TypeScript Worker、编辑、自动保存、Git Diff、模块切换、退出登录均通过，无浏览器运行错误。
- IM 与 Maikoo 两目录只读回归：20 / 11 个仓库、13 / 0 个变更文件，与之前结果一致；目录浏览不加载编辑器。
- [外网 HTTPS 验收](external-smoke.json)：真实域名登录、Secure/HttpOnly Cookie、按需工作区和 Monaco、WSS 及关闭工作区通过。写操作仅在自建临时测试目录执行。
- 临时 43111 测试服务已停止，本地 43110 健康检查正常。

截图：[HTML 等待画面](html-loading.png)、[编辑器等待画面](editor-loading.png)、[Git 差异](git-diff.png)、[外网编辑器](external-editor.png)。

## 后续线路判断

两次 HIT 样本中，61 KB 的入口脚本仍耗时约 1.8 秒；页面连接、TLS、HTML 首包和鉴权请求也存在等待。体积优化已经完成，剩余时间需要通过大陆多地测速区分边缘线路与 Tunnel/源站往返。

若继续调整，比较静态托管/CDN 时应同时测 HTML 和资产的首包时间，再决定迁移方案；API 与 WebSocket 可继续代理到现有 Tunnel。独立静态域名还需处理 Monaco Worker 的同源加载。

Cloudflare 规则建议：仅对当前域名 `/assets/*` 的公开构建资产启用缓存，Edge TTL / Browser TTL 尊重源站响应头；`/api/*` 和 WebSocket 继续回源；HTML 保持重新验证。当前规则已实际返回 HIT，暂不需要为获得缓存命中而修改控制台配置。
