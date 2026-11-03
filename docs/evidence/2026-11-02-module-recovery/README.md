# 动态模块跨发布兼容修复与 Cloudflare 复测

日期：2026-11-02，Asia/Shanghai。构建发布约在 21:02–21:03 完成。完整采样见 [measurements.json](measurements.json)，操作与回滚说明见[静态发布说明](../../static-deployment.md)。

## 说明原因

已确认修改前的 `npm run build` 直接执行 Vite，并通过 `emptyOutDir: true` 清空正在服务的 `dist/web`。这会造成构建期间的资源窗口，也会删除已打开页面稍后才请求的旧哈希模块。当前静态服务已经对缺失 `/assets/*` 返回 no-store 的 JSON 404，并未将它们送入 SPA fallback；修复重点是发布方式和资源保留。

旧资源缺失和 Cloudflare 边缘传输问题必须分开处理。本轮没有复现 LAX 模块截断或 500：已覆盖多个 POP 的完整下载，但 LAX 只采到首页。Cloudflare 的精确 Purge、临时 Bypass 和 LAX 模块专项验收仍未完成。

用户提供的 `/assets/workspaceRoot-4mVyy-hS.js` 本轮返回 404。它与真实存在的 `/assets/WorkspaceRoot-4mVyV-hS.js` 同时存在大小写和哈希字符差异；仓库历史只有 `src/web/WorkspaceRoot.tsx`。本次未找到该小写 URL 对应的原始发布产物，因此不能仅凭 404 确认它曾是有效构建文件，也没有把它映射到内容不同的新模块。若确属历史版本，仍需从相应发布包恢复原始字节。

另一个需要澄清的测量值：原工作区模块的源文件是 114,298 字节，32,677 字节是其 Brotli 编码体积。不同编码或 Cloudflare 重新压缩后的字节数不同，不等于截断；本轮比较的依据是解压后的长度和 SHA-256。

## 当前代码问题点

修改前没有构建保留清单，页面和静态资源也没有分阶段发布。安装器虽然保留版本目录，新服务只读取当前版本的资源目录，旧文件不会自动变得可访问。模块错误边界原来只提供手动重载，缺少有次数上限的恢复。

## 代码错误位置

- `package.json`、`vite.config.ts`：原构建输出指向在线目录并清空。
- `scripts/install.sh`、`scripts/install.ps1`：原升级切换没有向新版本继承旧资源。
- `src/web/main.tsx`、`src/web/LoadingBoundary.tsx`：原来没有处理 Vite preload 错误和刷新次数。

## 修改方案

1. 编译和打包在唯一的临时目录完成，校验 manifest 中的静态/动态依赖、CSS、资源及路径大小写。
2. 先发布新资源，禁止覆盖内容不同的同名 immutable 文件；最后原子替换首页。线上构建通过 `CODE_WORKSPACE_VERIFY_ORIGIN` 在切换前验证真实 HTTP 响应的状态、长度与 SHA-256。
3. 保留当前和两个历史构建的 HTML、文件清单及校验值；当前目录保留这些构建的资源合集。第一次切换自动记录现有构建作为基线。
4. 安装升级在停止旧服务前继承历史资源；Unix 使用预建符号链接后重命名切换 `current`。静态回滚使用原始 HTML 和文件名，不重新构建。
5. 明确的动态导入/CSS preload 失败最多自动刷新一次，用 sessionStorage 跨刷新记录预算。有未保存编辑、存储不可用或普通业务错误时不自动刷新。
6. Cloudflare 另做限定主机与 `/assets/` 的临时 Bypass 和精确 Purge。当前缺少可用的管理登录，这些操作尚未执行，不能把新文件首次 MISS 的成功当成边缘问题已解决。

## 修改的代码点

- `scripts/build.mjs`、`bin/web-release.mjs`：暂存构建、验证、资源保留、锁、回滚与安装继承。
- `vite.config.ts`：在实际暂存输出目录预压缩，并拒绝显式把正在服务的目录作为 Vite 输出目录。
- `src/web/chunkRecovery.ts`、`main.tsx`、`LoadingBoundary.tsx`、`App.tsx`：一次刷新预算和未保存编辑保护。
- 两个平台安装器、CI 和发布/静态服务回归：覆盖升级、旧客户端懒加载、保留窗口、回滚、大小写、同名冲突和符号链接入口。
- `src/web/AuthGate.test.tsx`：动态导入用例的两处元素等待从默认 1 秒改为 5 秒。初轮并行套件在该等待处超时，修改测试等待后以两个 worker 完整复跑通过；未改变生产请求超时。

## 验证方式

### 本机与发布过程

- 类型检查通过。
- `npm test -- --maxWorkers=2`：15 个文件、84 项测试全部通过。
- `npm run test:release`：9 项通过，包括真正先导入旧入口、发布新版、再执行旧入口的动态 import。
- 安装/服务管理/真实成品包回归：10 项通过，无跳过。成品包仅本地生成用于验证，没有发布 GitHub Release。
- 使用 `CODE_WORKSPACE_VERIFY_ORIGIN=http://127.0.0.1:43110 npm run build`，切换前经 HTTP 校验了新构建的全部 96 个未压缩资源。
- 构建期间连续读取旧入口、旧工作区和旧编辑器，共 393 次，零失败、零内容变化；切换后三者仍为完整 200。
- 显式执行指向 `dist/web` 的 Vite 构建，被保护逻辑提前拒绝，当前 HTML 哈希不变。

本机是 macOS。Windows 分支和 junction 用例已加入三平台 CI，本次没有在 Windows 实机执行。

### HTTP 与 HTTPS 复核

21:13（Asia/Shanghai）再次请求：HTTP 首页仍返回 200，无 Location，也没有升级到 HTTPS；HTTPS 首页返回 200，系统 curl 证书校验成功（ssl_verify_result=0）。本轮修复没有改变此项边缘配置。完整页面下载分别约 1.50 秒和 1.55 秒，来自 AMS/NRT 的不同请求路径，不能将这两个样本用于协议性能对比。HTTP 强制跳转仍待可用的 Cloudflare 管理登录后配置；前期首屏链路诊断见[加载与 HTTPS 诊断](../2026-11-02-site-diagnosis/README.md)。

### 当前部署身份

- 新构建 ID：`be672a02c4f243d070f5`。
- 发布前基线 ID：`c2ba8a71aac4d49e4daa`。
- 当前 HTML SHA-256：`1466a125b51057672e3deadad26cb3a72555af4c108b488c118ee720f9100e94`。
- 当前入口：`/assets/index-CAoHI508.js`。
- 当前工作区模块：`/assets/WorkspaceRoot-BtBcwAf1.js`。
- 原入口 `/assets/index-BuWlzUZ1.js` 和原模块 `/assets/WorkspaceRoot-4mVyV-hS.js` 已保留，字节不变。当前已有两个真实版本，后续继续保留最多三个版本。
- 本次无需重启本机 43110 服务，未主动关闭用户工作区。

### 外网结果与尚未覆盖项

发布前原模块 8 次 Brotli/Gzip 请求覆盖 AMS、LHR、HKG，均完整解压且匹配源站。

发布后新旧 HTML/入口/工作区模块共 14 次请求，全部 HTTP 200 且哈希匹配；覆盖 MAN、LHR、FRA、NRT，LAX 仅首页。NRT 观察到新入口和模块从 MISS 进入 HIT。随后复用单个 TLS 连接，新模块连续 3 次 HIT，约 0.15–0.36 秒，内容一致；旧模块 HIT 也通过。

当前没有凭据可以修改该 zone 的缓存规则：本机 Wrangler OAuth 已过期，API 返回 Invalid access token，其原始权限也不包含 Cache Rules 编辑。浏览器连接不可用，未通过其他方式绕过登录。

因此尚不能勾选“LAX 模块多次 HIT 均通过”或“临时 Bypass 对照完成”。等待可用管理登录后，按 measurements.json 中的精确计划执行，继续采集原故障 POP 的 CF-RAY、编码、实际字节和解压哈希。没有执行 Purge Everything，也没有因为没有权限而擅自关闭源站缓存或压缩。

## 回滚建议

```bash
npm run web:releases
npm run web:rollback -- c2ba8a71aac4d49e4daa
```

这会回到本次发布前的 HTML，并保留当前版本的资源用于已打开的新页面。生产回滚前需确认前后端 API 兼容；本轮回滚功能已在隔离构建中验证，未切换用户当前页面做重复试验。
