import { spawn } from "node:child_process";
import { config } from "../config.js";
import { AppError } from "../errors.js";

export class GitRunner {
  constructor(private cwd: string) {}

  run(args: string[], options: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd: this.cwd,
        shell: false,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); reject(error); } };
      const timer = setTimeout(() => fail(new AppError(504, "GIT_TIMEOUT", "Git 查询超时")), options.timeoutMs ?? config.gitTimeoutMs);
      child.on("error", () => fail(new AppError(503, "GIT_UNAVAILABLE", "无法运行 Git")));
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > config.gitMaxOutputBytes) fail(new AppError(413, "GIT_OUTPUT_TOO_LARGE", "Git 输出超过限制")); else stdout.push(chunk); });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0 && !options.allowFailure) reject(new AppError(503, "GIT_COMMAND_FAILED", Buffer.concat(stderr).toString("utf8").trim() || "Git 查询失败"));
        else resolve(Buffer.concat(stdout));
      });
    });
  }

  async text(args: string[], options?: { allowFailure?: boolean; timeoutMs?: number }) { return (await this.run(args, options)).toString("utf8"); }
}
