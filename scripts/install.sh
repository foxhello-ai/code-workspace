#!/usr/bin/env sh
set -eu

export LC_ALL=C
export LANG=C

REPOSITORY="${CODE_WORKSPACE_RELEASE_REPOSITORY:-foxhello-ai/code-workspace}"
API_BASE="${CODE_WORKSPACE_RELEASE_API_BASE:-https://api.github.com}"
DOWNLOAD_BASE="${CODE_WORKSPACE_RELEASE_DOWNLOAD_BASE:-https://github.com}"
APP_HOME="${CODE_WORKSPACE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/code-workspace}"
BIN_DIR="${CODE_WORKSPACE_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/code-workspace"
CONFIG_FILE="$CONFIG_DIR/config.env"
VERSION_REQUEST="${CODE_WORKSPACE_VERSION:-latest}"
INSTALL_HOST="${HOST:-127.0.0.1}"
INSTALL_PORT="${PORT:-43110}"

fail() {
  echo "安装失败：$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "需要 curl。"
command -v tar >/dev/null 2>&1 || fail "需要 tar。"
command -v node >/dev/null 2>&1 || fail "需要 Node.js 22 或更高版本。"

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
case "$node_major" in ''|*[!0-9]*) fail "无法识别 Node.js 版本。" ;; esac
[ "$node_major" -ge 22 ] || fail "需要 Node.js 22 或更高版本，当前版本为 $(node --version)。"

if [ "$VERSION_REQUEST" = "latest" ]; then
  release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API_BASE/repos/$REPOSITORY/releases/latest")" || fail "无法获取最新 GitHub Release。"
  tag="$(printf '%s' "$release_json" | node -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { body += chunk; }); process.stdin.on("end", () => { try { const tag = JSON.parse(body).tag_name; if (typeof tag === "string") process.stdout.write(tag); } catch {} });')"
  [ -n "$tag" ] || fail "GitHub Release 返回中缺少 tag_name。"
else
  tag="${VERSION_REQUEST#v}"
  tag="v$tag"
fi

version="${tag#v}"
archive_name="code-workspace-$version.tar.gz"
release_base="$DOWNLOAD_BASE/$REPOSITORY/releases/download/$tag"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM
archive_path="$temporary_dir/$archive_name"
checksum_path="$archive_path.sha256"

curl -fsSL --retry 3 --retry-delay 1 -o "$archive_path" "$release_base/$archive_name" || fail "下载发布包失败：$tag"
curl -fsSL --retry 3 --retry-delay 1 -o "$checksum_path" "$release_base/$archive_name.sha256" || fail "下载校验文件失败：$tag"

expected_checksum="$(awk 'NF { print $1; exit }' "$checksum_path")"
case "$expected_checksum" in
  ????????*) ;;
  *) fail "发布包校验文件格式无效。" ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$archive_path" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
else
  fail "需要 sha256sum 或 shasum 用于校验发布包。"
fi
[ "$expected_checksum" = "$actual_checksum" ] || fail "发布包 SHA-256 校验失败。"

tar -xzf "$archive_path" -C "$temporary_dir"
[ -f "$temporary_dir/code-workspace/dist/server/server/index.js" ] || fail "发布包内容不完整。"

target_dir="$APP_HOME/versions/$version"
mkdir -p "$APP_HOME/versions" "$BIN_DIR" "$CONFIG_DIR"
if [ ! -d "$target_dir" ]; then
  mv "$temporary_dir/code-workspace" "$target_dir"
fi
ln -sfn "$target_dir" "$APP_HOME/current"
ln -sfn "$APP_HOME/current/bin/code-workspace" "$BIN_DIR/code-workspace"
chmod +x "$target_dir/bin/code-workspace"

if [ ! -f "$CONFIG_FILE" ]; then
  password="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
  umask 077
  cat > "$CONFIG_FILE" <<EOF
HOST=$INSTALL_HOST
PORT=$INSTALL_PORT
APP_PASSWORD=$password
EOF
fi

"$BIN_DIR/code-workspace" start

echo "安装完成：http://127.0.0.1:$INSTALL_PORT"
echo "配置文件：$CONFIG_FILE"
echo "访问密码：$(sed -n 's/^APP_PASSWORD=//p' "$CONFIG_FILE" | head -n 1)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "将 $BIN_DIR 加入 PATH 后，可直接使用：code-workspace status" ;;
esac
