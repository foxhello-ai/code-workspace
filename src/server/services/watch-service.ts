import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { config } from "../config.js";
import { WorkspaceService } from "./workspace-service.js";
import { EventHub } from "./event-hub.js";
import { GitService } from "./git-service.js";

export class WatchService {
  private watcher: FSWatcher | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  constructor(private workspace: WorkspaceService, private git: GitService, private hub: EventHub) {}

  async start() {
    await this.stop();
    const context = this.workspace.get();
    const root = context.info.rootPath;
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: (candidate) => {
        const rel = path.relative(root, candidate).replaceAll("\\", "/");
        if (!rel) return false;
        if (rel === ".git") return false;
        if (rel.startsWith(".git/")) return !(/^\.git\/(HEAD|index|refs\/)/.test(rel));
        return /(^|\/)(\.git|node_modules|target|dist|build|coverage|\.gradle|\.idea|\.cursor)(\/|$)/.test(rel) || /(~|\.swp|\.tmp)$/.test(rel);
      }
    });
    const send = (type: string, absolute: string) => {
      const rel = path.relative(root, absolute).replaceAll("\\", "/");
      if (!rel || rel.startsWith(".git/")) { this.scheduleGit(); return; }
      const key = `${type}:${rel}`;
      const prior = this.pending.get(key); if (prior) clearTimeout(prior);
      this.pending.set(key, setTimeout(() => {
        this.pending.delete(key);
        this.hub.emit(context.info.id, { type, path: rel });
        this.scheduleGit();
      }, 100));
    };
    this.watcher.on("add", (p) => send("file.created", p));
    this.watcher.on("change", (p) => send("file.changed", p));
    this.watcher.on("unlink", (p) => send("file.deleted", p));
    this.watcher.on("addDir", (p) => send("directory.created", p));
    this.watcher.on("unlinkDir", (p) => send("directory.deleted", p));
    this.watcher.on("error", () => {
      this.git.invalidate();
      this.hub.emit(context.info.id, { type: "watcher.error" });
    });
  }

  private scheduleGit() {
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(async () => {
      this.git.invalidate();
      try {
        const context = this.workspace.get();
        if (!context.info.git) return;
        const snapshot = await this.git.status(true);
        this.hub.emit(context.info.id, { type: "git.statusChanged", revision: snapshot.revision });
      } catch { /* file editing remains available */ }
    }, config.watchDebounceMs);
  }

  async stop() {
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
