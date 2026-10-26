import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function passwordFromEnvFile() {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((item) => item.startsWith("APP_PASSWORD="));
  return line?.slice("APP_PASSWORD=".length).trim() ?? "";
}

export const config = {
  serviceInstanceId: process.env.CODE_WORKSPACE_INSTANCE_ID ?? "",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 43110),
  fileWarnBytes: Number(process.env.FILE_WARN_BYTES ?? 2 * 1024 * 1024),
  fileReadonlyBytes: Number(process.env.FILE_READONLY_BYTES ?? 10 * 1024 * 1024),
  gitFetchTimeoutMs: Number(process.env.GIT_FETCH_TIMEOUT_MS ?? 60_000),
  gitWorktreeLimit: Number(process.env.GIT_WORKTREE_LIMIT ?? 200),
  gitStatusLimit: Number(process.env.GIT_STATUS_LIMIT ?? 40),
  gitTimeoutMs: Number(process.env.GIT_TIMEOUT_MS ?? 10_000),
  gitMaxOutputBytes: Number(process.env.GIT_MAX_OUTPUT_BYTES ?? 50 * 1024 * 1024),
  gitDiscoveryDepth: Number(process.env.GIT_DISCOVERY_DEPTH ?? 1),
  gitDiscoveryMaxDirs: Number(process.env.GIT_DISCOVERY_MAX_DIRS ?? 200),
  gitDiscoveryTimeoutMs: Number(process.env.GIT_DISCOVERY_TIMEOUT_MS ?? 5000),
  watchDebounceMs: Number(process.env.WATCH_DEBOUNCE_MS ?? 250),
  watchMaxFiles: Number(process.env.WATCH_MAX_FILES ?? 5000),
  appPassword: process.env.APP_PASSWORD ?? (process.env.NODE_ENV === "test" ? "test-password" : passwordFromEnvFile())
};
