# 安装与运行

Code Workspace 以本机 Web 服务形式运行，支持 macOS、Linux 和 Windows 11 x64。安装脚本只下载编译好的 Release 和生产依赖，无需克隆源码、执行 npm install 或编译。Windows 不依赖 WSL 或 Git Bash。

## 前置条件

- Node.js 22 或更高版本
- Git 2.39 或更高版本（worktree 登记使用 `git worktree list --porcelain -z`）
- macOS/Linux：`curl`、`tar`，以及 `sha256sum` 或 `shasum`
- Windows：Windows PowerShell 5.1 或 PowerShell 7，x64 系统

Windows 缺少运行环境时可执行以下命令，完成后重新打开 PowerShell：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

服务默认仅监听 `127.0.0.1:43110`，不会暴露到局域网或互联网。

## 一条命令安装

**macOS / Linux**：安装最新版、校验发布包、生成随机访问密码并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

**Windows 11 x64**：在普通 PowerShell 窗口执行：

```powershell
irm https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.ps1 | iex
```

两个脚本都会下载平台对应的发布包，校验 SHA-256、安装到当前用户目录并在后台启动，无需管理员权限来安装 Code Workspace。安装完成后访问 `http://127.0.0.1:43110`，终端会输出随机访问密码。

macOS/Linux 密码保存在 `~/.config/code-workspace/config.env`；Windows 保存在 `$env:LOCALAPPDATA\CodeWorkspace\config\config.json`，配置目录 ACL 仅允许当前 Windows 账户读取。在页面使用 `D:\projects\my-project` 等路径打开 Windows 本机目录。

安装脚本从 GitHub Latest Release 的稳定下载地址获取发布包，并对下载内容执行 SHA-256 校验，不依赖 GitHub API 配额。需要安装指定版本时：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | CODE_WORKSPACE_VERSION=1.1.2 bash
```

Windows 指定版本：

```powershell
$env:CODE_WORKSPACE_VERSION = '1.1.2'
irm https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.ps1 | iex
```

## 日常使用

macOS/Linux 安装目录为 `~/.local/share/code-workspace`，命令会链接到 `~/.local/bin/code-workspace`。若该目录不在 `PATH` 中，执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

可写入 shell 配置文件使其永久生效，例如 `~/.zshrc` 或 `~/.bashrc`。

Windows 安装到 `$env:LOCALAPPDATA\CodeWorkspace`，命令位于该目录的 `bin\code-workspace.cmd`；脚本会加入用户 PATH 并更新当前 PowerShell。使用 CMD 启动器避免受 `.ps1` 执行策略影响，无需修改系统执行策略。两类安装均支持：

```bash
code-workspace start
code-workspace status
code-workspace logs
code-workspace restart
code-workspace stop
```

安装脚本会自动执行 `start`，关闭安装终端后服务继续运行；当前不注册系统服务或开机自启。macOS/Linux 日志位于 `~/.local/state/code-workspace/server.log`，PID 位于同目录的 `server.pid`。Windows 日志与进程状态分别位于安装目录的 `state\server.log`、`state\server.json`。

重新执行安装命令即可升级到最新 Release。脚本会保留配置和密码，先停止原安装服务，再切换并启动所选版本，确保运行进程加载新代码。升级前请保存编辑内容。旧版本保存在安装目录的 `versions` 下；macOS/Linux 用 `current` 符号链接指向当前版本，Windows 用 `current.json` 记录路径，不需要创建符号链接。

Windows 服务管理通过随机实例标记确认 PID 归属，停止命令不会终止 PID 已复用的其他程序；启动时会检查端口和健康检查的实例标记，避免把另一个服务误认作启动成功。端口占用时会报错并保留日志。

## 配置

配置文件为 `~/.config/code-workspace/config.env`：

```ini
HOST=127.0.0.1
PORT=43110
APP_PASSWORD=安装时生成的随机密码
```

修改端口或密码后执行 `code-workspace restart`。可以在命令前传入环境变量临时覆盖，例如：

```bash
PORT=43111 APP_PASSWORD='replace-with-a-strong-password' code-workspace restart
```

Windows 配置使用 JSON：

```json
{
  "HOST": "127.0.0.1",
  "PORT": 43110,
  "APP_PASSWORD": "安装时生成的随机密码"
}
```

在 PowerShell 中修改配置后执行 `code-workspace restart`；或通过 `$env:PORT = '43111'` 临时覆盖。可通过 `CODE_WORKSPACE_HOME` 自定义安装根目录，`CODE_WORKSPACE_BIN_DIR` 自定义命令目录；两个平台均支持路径中包含空格，Windows 还验证中文路径。

不要将 `HOST` 改为 `0.0.0.0` 或公网地址，除非另行配置 TLS、网络访问控制和强密码。Code Workspace 用于编辑本机文件，默认只允许本机浏览器访问是必要的安全边界。

## 发布维护者

GitHub Actions 对 `main`、PR 和手动触发执行 Linux/macOS/Windows 三系统检查。推送与 `package.json` 版本完全一致的 tag 时，三个系统全部通过后才创建 Release。例如当前版本为 `1.1.2`：

```bash
git tag v1.1.2
git push origin v1.1.2
```

上面的 tag 命令仅用于演示流程。已发布 tag 不应覆盖；发布新内容时先更新 `package.json` 和 `package-lock.json` 的版本，再创建新 tag。推送 `main` 只运行验证，不公开 Release；一键安装取得的是最新已发布版本。

Release 包含 macOS/Linux 的 `code-workspace-<version>.tar.gz`、Windows x64 的 `code-workspace-<version>-windows-x64.zip`，以及对应 `latest` 别名和 SHA-256 文件。ZIP 在 Windows runner 构建，附带 Windows 生产依赖；包内包含中英文 README，不包含 `src` 或 TypeScript 编译器。工作流位于 `.github/workflows/release.yml`。

公开发布前，工作流还执行安装回归：首次/重复安装、升级后实际运行版本、配置与密码保留、错误校验和拒绝，以及真实生产包的页面资源、登录和 Git/Worktree API。可在本地复现：

```bash
npm run package:release
CODE_WORKSPACE_TEST_ARCHIVE="release/code-workspace-$(node -p 'require("./package.json").version').tar.gz" node --test scripts/install.test.mjs scripts/service-manager.test.mjs
```

Windows 维护者验证（使用随系统提供的 Windows PowerShell 5.1 执行安装脚本）：

```powershell
npm.cmd run package:release
$version = node -p "require('./package.json').version"
$env:CODE_WORKSPACE_TEST_ARCHIVE = "release/code-workspace-$version-windows-x64.zip"
node --test scripts/install.test.mjs scripts/service-manager.test.mjs
```
