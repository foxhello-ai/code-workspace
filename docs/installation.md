# 安装与运行

Code Workspace 以本机 Web 服务形式运行，支持 macOS 和 Linux。发布包已经包含编译产物和生产依赖，运行时不需要从 npm 下载依赖。

## 前置条件

- Node.js 22 或更高版本
- Git 2.39 或更高版本（worktree 登记使用 `git worktree list --porcelain -z`）
- `curl`、`tar`，以及 `sha256sum` 或 `shasum`

服务默认仅监听 `127.0.0.1:43110`，不会暴露到局域网或互联网。

## 一条命令安装

安装最新版、校验发布包、生成随机访问密码并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

安装完成后在浏览器访问 `http://127.0.0.1:43110`。终端会输出访问密码；密码保存在 `~/.config/code-workspace/config.env`，该文件权限仅限当前用户读取。

安装脚本从 GitHub Latest Release 的稳定下载地址获取发布包，并对下载内容执行 SHA-256 校验，不依赖 GitHub API 配额。需要安装指定版本时：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | CODE_WORKSPACE_VERSION=1.1.1 bash
```

## 日常使用

安装目录为 `~/.local/share/code-workspace`，命令会链接到 `~/.local/bin/code-workspace`。若该目录不在 `PATH` 中，执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

可写入 shell 配置文件使其永久生效，例如 `~/.zshrc` 或 `~/.bashrc`。

```bash
code-workspace start
code-workspace status
code-workspace logs
code-workspace restart
code-workspace stop
```

安装脚本会自动执行 `start`。运行日志位于 `~/.local/state/code-workspace/server.log`，进程号位于同目录的 `server.pid`。

重新执行一条命令安装即可升级到最新 Release。脚本会保留配置和密码，先停止原安装服务，再切换 `current` 并启动所选版本，确保运行中的进程加载新代码。升级会重启服务，请先保存编辑内容。旧版本会保留在 `~/.local/share/code-workspace/versions`，当前版本由 `current` 符号链接指向。

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

不要将 `HOST` 改为 `0.0.0.0` 或公网地址，除非另行配置 TLS、网络访问控制和强密码。Code Workspace 用于编辑本机文件，默认只允许本机浏览器访问是必要的安全边界。

## 发布维护者

GitHub Actions 在推送与 `package.json` 版本完全一致的 tag 时自动执行检查、构建并创建 Release。例如当前版本为 `1.1.1`：

```bash
git tag v1.1.1
git push origin v1.1.1
```

上面的 tag 命令仅用于演示流程。已发布的 tag 不应覆盖；发布新内容时先更新 `package.json` 和 `package-lock.json` 的版本，再创建新的对应 tag。推送 `main` 不触发 Release，一键安装取得的是最新已发布版本，可能落后于源码功能。

Release 包含 `code-workspace-<version>.tar.gz`、稳定名称 `code-workspace-latest.tar.gz` 及各自的 SHA-256 文件；包内包含中英文 README。工作流文件位于 `.github/workflows/release.yml`。

公开发布前，工作流还执行安装回归：首次/重复安装、升级后实际运行版本、配置与密码保留、错误校验和拒绝，以及真实生产包的页面资源、登录和 Git/Worktree API。可在本地复现：

```bash
npm run package:release
CODE_WORKSPACE_TEST_ARCHIVE="release/code-workspace-$(node -p 'require("./package.json").version').tar.gz" node --test scripts/install.test.mjs
```
