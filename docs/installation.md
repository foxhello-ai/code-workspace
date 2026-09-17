# 安装与运行

Code Workspace 以本机 Web 服务形式运行，支持 macOS 和 Linux。发布包已经包含编译产物和生产依赖，运行时不需要从 npm 下载依赖。

## 前置条件

- Node.js 22 或更高版本
- Git 2.30 或更高版本
- `curl`、`tar`，以及 `sha256sum` 或 `shasum`

服务默认仅监听 `127.0.0.1:43110`，不会暴露到局域网或互联网。

## 一条命令安装

安装最新版、校验发布包、生成随机访问密码并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

安装完成后在浏览器访问 `http://127.0.0.1:43110`。终端会输出访问密码；密码保存在 `~/.config/code-workspace/config.env`，该文件权限仅限当前用户读取。

安装脚本从 GitHub Latest Release 下载固定版本发布包，并对下载内容执行 SHA-256 校验。需要安装指定版本时：

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | CODE_WORKSPACE_VERSION=1.1.0 bash
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

重新执行一条命令安装即可升级到最新 Release。旧版本会保留在 `~/.local/share/code-workspace/versions`，当前版本由 `current` 符号链接指向。

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

GitHub Actions 在推送与 `package.json` 版本完全一致的 tag 时自动执行检查、构建并创建 Release。例如当前版本为 `1.1.0`：

```bash
git tag v1.1.0
git push origin v1.1.0
```

Release 包含 `code-workspace-<version>.tar.gz` 与对应的 SHA-256 文件。工作流文件位于 `.github/workflows/release.yml`。
