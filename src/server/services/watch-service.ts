import chokidar, { type FSWatcher } from "chokidar";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { WorkspaceService } from "./workspace-service.js";
import { EventHub } from "./event-hub.js";
import { GitService } from "./git-service.js";

export class WatchService {
  private metadataWatcher: FSWatcher | null = null;
  private watcher: FSWatcher | null = null;
  private gitTimer: NodeJS.Timeout | null = null;
  private gitRefresh: Promise<void> | null = null;
  private stopped = true;
  private pending = new Map<string, NodeJS.Timeout>();
  constructor(private workspace: WorkspaceService, private git: GitService, private hub: EventHub) {}

  async start() {
    await this.stop();
    this.stopped = false;
    const context = this.workspace.get();
    const root = context.info.rootPath;
    const groups = context.info.repositoryGroups ?? [];
    const roots = [...new Set(groups.map(g => g.commonDir))];
    const ignoreMetadata = (candidate: string) => {
      const base = roots.find(r => candidate === r || candidate.startsWith(`${r}${path.sep}`));
      if (!base) return false;
      const rel = path.relative(base, candidate).replaceAll("\\", "/");
      return Boolean(rel) && !(/^(HEAD|index|packed-refs|shallow|config|refs)(\/|$)/.test(rel) || /^worktrees(\/[^/]+(\/(HEAD|index|gitdir|commondir|locked))?)?$/.test(rel));
    };
    let metadataCount = 0;
    // Count only permitted metadata; exceeding the bound disables metadata watching explicitly.
    const countMetadata = async (directory: string): Promise<void> => {
      if (metadataCount > 5000) return;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const absolute = path.join(directory, entry.name);
        if (ignoreMetadata(absolute)) continue;
        if (++metadataCount > 5000) return;
        if (entry.isDirectory()) await countMetadata(absolute);
      }
    };
    await Promise.all(roots.map(countMetadata));
    if (metadataCount > 5000) this.hub.emit(context.info.id, { type: "watcher.metadataDisabled" });
    else {
      this.metadataWatcher = chokidar.watch(roots, { ignoreInitial: true, followSymlinks: false, ignored: ignoreMetadata });
      this.metadataWatcher.on("all", () => this.scheduleGit());
      this.metadataWatcher.on("error", () => this.hub.emit(context.info.id, { type: "watcher.metadataError" }));
    }
    const watchableEntries = await this.countWatchableEntries(root);
    if (watchableEntries > config.watchMaxFiles) {
      this.hub.emit(context.info.id, { type: "watcher.disabled", version: String(watchableEntries) });
      return;
    }
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: (candidate) => this.ignored(root, candidate)
    });
    const send = (type: string, absolute: string) => {
      if (this.stopped) return;
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
    if (this.stopped) return;
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => {
      this.gitTimer = null;
      if (this.stopped) return;
      if (this.gitRefresh) { this.scheduleGit(); return; }
      const refresh = (async () => {
        this.git.invalidate();
        try {
          const context = this.workspace.get();
          if (!context.info.git) return;
          await this.workspace.refreshGitInfo();
          if (this.stopped) return;
          const snapshot = await this.git.status(true);
          if (!this.stopped) this.hub.emit(context.info.id, { type: "git.statusChanged", revision: snapshot.revision });
        } catch { /* file editing remains available */ }
      })();
      this.gitRefresh = refresh;
      void refresh.finally(() => { if (this.gitRefresh === refresh) this.gitRefresh = null; });
    }, config.watchDebounceMs);
  }

  private ignored(root: string, candidate: string) {
    const rel = path.relative(root, candidate).replaceAll("\\", "/");
    if (!rel) return false;
    if (rel === ".git" || rel.startsWith(".git/")) return true;
    return /(^|\/)(\.git|node_modules|target|dist|build|coverage|\.gradle|\.idea|\.cursor)(\/|$)/.test(rel) || /(~|\.swp|\.tmp)$/.test(rel);
  }

  private async countWatchableEntries(root: string) {
    if (config.watchMaxFiles <= 0) return 0;
    let count = 0;
    const queue = [root];
    while (queue.length) {
      const current = queue.shift()!;
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (this.ignored(root, absolute)) continue;
        count++;
        if (count > config.watchMaxFiles) return count;
        if (entry.isDirectory()) queue.push(absolute);
      }
    }
    return count;
  }

  async stop() {
    this.stopped = true;
    if (this.gitTimer) clearTimeout(this.gitTimer);
    this.gitTimer = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.metadataWatcher) await this.metadataWatcher.close();
    this.metadataWatcher = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    // Git child processes hold their cwd open on Windows. Do not finish closing
    // the workspace until the in-flight refresh has released those handles.
    await this.gitRefresh;
  }
}
