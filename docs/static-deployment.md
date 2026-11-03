# 静态发布、旧页面兼容与 CDN 故障处理

## 源码部署

使用 `npm run build`。TypeScript 和 Vite 先在唯一的 `dist/.build-*` 临时目录生成完整产物；失败时不会清空正在服务的网页目录。直接执行 `vite build` 只生成 `dist/web-build`，不会发布；显式指定正在服务的 `dist/web` 会被拒绝。

发布工具会检查 Vite manifest 的静态/动态依赖、CSS 和资源文件是否存在，逐段核对文件名大小写，再将新资源加入 `dist/web/assets`。已有同名资源必须具有相同内容，禁止覆盖一个 immutable URL。所有资源就绪后，最后用同目录文件重命名替换 `index.html`。

线上构建还应指定正在运行的**本机源站**作为验证入口：

```bash
CODE_WORKSPACE_VERIFY_ORIGIN=http://127.0.0.1:43110 npm run build
```

此时会在切换 HTML 前，通过真实 HTTP 服务读取新版本的所有未压缩资源，检查 200、长度和 SHA-256。任何一项失败都保留当前 HTML。不要将此地址指向另一个安装实例；公网 CDN 的检查应另外执行，以区分本机发布完整性和边缘链路故障。

`dist/web.releases/history.json` 保存当前及两个历史构建的原始 HTML、资源清单、长度和校验值。`assets` 是这些构建的资源合集；只在新首页完成切换后清理超出三个版本的文件。第一次采用该流程时，会将已有生产资源作为基线保留，即使旧构建没有 manifest。

不要再对正在服务的 `dist/web` 运行删除、清空、覆盖式同步。部署到其他机器时应在那台机器完成上述发布步骤，而非用 `rsync --delete` 同步整个目录。构建期间不要并行打包；残留 `publish.lock` 表示发布进程被异常终止，需要先确认没有发布进程运行再手工移除锁目录。

## 安装包升级

新发布包包含 `bin/web-release.mjs`。macOS/Linux 和 Windows 安装器会在停止旧服务之前，将旧版本的最近两个资源清单和对应文件合并到待启用版本，核对字节和大小写后再切换版本。Unix 的 `current` 使用预建符号链接后重命名，Windows 继续使用临时 JSON 文件后切换。

旧版本目录继续保留。使用新安装器回装一个历史版本时，只要当前或目标版本含该工具，也会先继承当前资源，减少版本回退对已打开页面的影响。升级仍需切换后端进程；静态资源兼容不能保留后端内存中的工作区会话。

## 静态回滚

```bash
npm run web:releases
npm run web:rollback -- <列表中的完整构建ID>
```

回滚使用记录的 HTML 和原始文件名，先校验所有资源，再切换首页，不重新构建。仅适用于保留期内、与当前后端 API 兼容的网页版本；完整程序回滚应安装对应 Release。

HTML 继续使用 `Cache-Control: no-cache`；哈希资源继续使用 `public, max-age=31536000, immutable`。保留三个构建不代表永久保留任意历史页面，超过保留窗口的客户端可能需要刷新。

## 动态导入恢复

入口捕获 `vite:preloadError`，模块边界也检查同类错误。只对明确的模块/CSS 预加载失败自动刷新，刷新前先写 sessionStorage 标记，每个标签页会话最多一次；第二次仍失败则保留手动重载按钮。

存在未保存编辑、sessionStorage 不可用、或普通业务运行错误时，不自动刷新。首次入口脚本本身下载失败、尚未执行时无法运行该恢复代码；已经在内存中的旧入口也不会凭空获得新增的恢复逻辑。

## Cloudflare 定向处理

旧资源删除和边缘传输异常需要分开验证。资源丢失应恢复对应原始产物；不要把错误大小写或旧哈希 URL 重定向、映射到一个内容不同的新模块。

对于当前报告的缓存异常，在 `foxhello.cn` 下建立**临时 Cache Rule**，限制为：

```text
(http.host eq "workspace.foxhello.cn" and starts_with(http.request.uri.path, "/assets/"))
```

将 Cache eligibility 设为 Bypass cache；确保没有后续同域名匹配规则重新启用缓存。不要绕过整个 zone，也不要缓存鉴权、文件 API 或 WebSocket。此规则用于对照定位，不应在未测量前认定它已解决故障。

随后按 URL 精确 Purge：当前 HTML 中的入口 URL、入口实际导入的工作区模块，以及证据中失败的其他具体资产。发布后文件名会变化，必须从当前 HTML/对应的构建记录读取，不能照抄旧报告中的文件名。不要 Purge Everything。

验证应包括：

1. 记录请求的 CF-RAY / POP、HTTP 版本、编码、状态码、耗时、实际接收字节数。
2. 对相同 URL 连续请求，测试 identity、gzip 和 Brotli；解压后比较源文件 SHA-256。不能用不同编码之间的压缩字节数直接判断截断。
3. 单独发 Range 请求时可返回 206；随后正常模块请求必须完整返回 200，不应继承 Content-Range。
4. 在原故障 LAX 路径和一条正常路径重复测试 Bypass。恢复缓存规则后，还要重新测试 MISS → 多次 HIT，避免把一次 Purge 的短暂好转当成修复。
5. 若只有特定 POP/HTTP 版本/编码失败，保留 CF-RAY 和时间交给 Cloudflare 支持调查。不要关闭 TLS 校验，也不要仅靠随机查询参数长期规避。

如果没有可用的 Cache Purge 和 Cache Rules 编辑权限，只能完成代码与源站验证，不能宣称 Cloudflare 已修复。Wrangler 的 `zone:read` 和 Workers 权限不等于缓存规则编辑权限。
