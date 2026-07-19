import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function passwordFromEnvFile() {
  const file = path.resolve(process.cwd(), ".env");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((item) => item.startsWith("APP_PASSWORD="));
  return line?.slice("APP_PASSWORD=".length).trim() ?? "";
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4311),
  fileWarnBytes: Number(process.env.FILE_WARN_BYTES ?? 2 * 1024 * 1024),
  fileReadonlyBytes: Number(process.env.FILE_READONLY_BYTES ?? 10 * 1024 * 1024),
  gitTimeoutMs: Number(process.env.GIT_TIMEOUT_MS ?? 10_000),
  gitMaxOutputBytes: Number(process.env.GIT_MAX_OUTPUT_BYTES ?? 50 * 1024 * 1024),
  watchDebounceMs: Number(process.env.WATCH_DEBOUNCE_MS ?? 250),
  appPassword: process.env.APP_PASSWORD ?? (process.env.NODE_ENV === "test" ? "test-password" : passwordFromEnvFile() || "")
};
