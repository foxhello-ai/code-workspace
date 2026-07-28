import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
import { WorkspaceService } from "./services/workspace-service.js";
import { FileService } from "./services/file-service.js";
import { GitService } from "./services/git-service.js";
import { EventHub } from "./services/event-hub.js";
import { WatchService } from "./services/watch-service.js";
import { AuthService } from "./services/auth-service.js";
import type { WorkspaceChangeSummary, WorkspaceInfo } from "../shared/contracts.js";

export async function buildApp(options: { disableAuth?: boolean } = {}) {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024, genReqId: () => crypto.randomUUID() });
  await app.register(websocket);
  const auth = new AuthService();
  const sessions = new Map<string, { workspace: WorkspaceService; git: GitService; hub: EventHub; watcher: WatchService; files: FileService }>();
  const sessionId = (request: { headers: Record<string, unknown>; query?: unknown }) => {
    const header = request.headers["x-code-workspace-session"];
    const query = typeof request.query === "object" && request.query ? (request.query as Record<string, unknown>).sessionId : undefined;
    return (typeof header === "string" && header) || (typeof query === "string" && query) || "default";
  };
  const session = (request: { headers: Record<string, unknown>; query?: unknown }) => {
    const id = sessionId(request);
    const existing = sessions.get(id);
    if (existing) return existing;
    const workspace = new WorkspaceService();
    const git = new GitService(workspace);
    const hub = new EventHub();
    const watcher = new WatchService(workspace, git, hub);
    const files = new FileService(workspace, () => null);
    workspace.onChange = async (context) => { await watcher.stop(); git.invalidate(); hub.clear(); if (context) await watcher.start(); };
    const created = { workspace, git, hub, watcher, files };
    sessions.set(id, created);
    return created;
  };

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "服务器内部错误");
    if (!(error instanceof AppError)) request.log.error(error);
    reply.status(appError.status).send({ error: { code: appError.code, message: appError.message, details: appError.details }, requestId: request.id });
  });

  const isSecure = (request: { headers: Record<string, unknown> }) => request.headers["x-forwarded-proto"] === "https";
  app.addHook("onRequest", async (request, reply) => {
    const publicApi = request.url === "/health" || request.url.startsWith("/api/auth/");
    if (!options.disableAuth && request.url.startsWith("/api/") && !publicApi && !auth.isAuthenticated(request.headers.cookie)) {
      return reply.status(401).send({ error: { code: "AUTH_REQUIRED", message: "请先登录" }, requestId: request.id });
    }
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (request) => ({ data: { authenticated: auth.isAuthenticated(request.headers.cookie) }, requestId: request.id }));
  app.post<{ Body: { password: string } }>("/api/auth/login", async (request, reply) => {
    const result = auth.login(request.body?.password ?? "", request.ip);
    if (!result.ok) return reply.status(result.blocked ? 429 : 401).send({ error: { code: result.blocked ? "AUTH_RATE_LIMITED" : "INVALID_PASSWORD", message: result.blocked ? `尝试次数过多，请 ${result.retryAfter} 秒后重试` : "密码错误" }, requestId: request.id });
    return reply.header("set-cookie", auth.cookie(isSecure(request))).send({ data: { authenticated: true }, requestId: request.id });
  });
  app.post("/api/auth/logout", async (request, reply) => reply.header("set-cookie", auth.clearCookie(isSecure(request))).send({ data: { authenticated: false }, requestId: request.id }));
  app.post<{ Body: { path: string } }>("/api/workspace/open", async (request) => {
    const scope = session(request);
    const info = await scope.workspace.open(request.body.path);
    return { data: await withChangeCounts(scope, info), requestId: request.id };
  });
  app.get("/api/workspace", async (request) => {
    const scope = session(request);
    return { data: await withChangeCounts(scope), requestId: request.id };
  });
  app.post("/api/workspace/close", async (request) => { await session(request).workspace.close(); return { data: null, requestId: request.id }; });
  app.post<{ Body: { paths: string[] } }>("/api/workspaces/change-summary", async (request) => {
    const paths = Array.isArray(request.body?.paths) ? request.body.paths.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
    const data = await Promise.all(paths.map(workspaceChangeSummary));
    return { data, requestId: request.id };
  });

  const gitState = (file: { indexStatus: string; worktreeStatus: string; categories: string[] }) => {
    if (file.categories.includes("conflicted")) return "conflicted";
    if (file.categories.includes("untracked")) return "untracked";
    const code = file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus;
    return code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
  };
  const insideOrSame = (parent: string, child: string) => parent === "" || child === parent || child.startsWith(`${parent}/`);
  const relativeToRepo = (workspacePath: string, repoPath: string) => repoPath ? workspacePath === repoPath ? "" : workspacePath.startsWith(`${repoPath}/`) ? workspacePath.slice(repoPath.length + 1) : null : workspacePath;
  const withChangeCounts = async (scope: { workspace: WorkspaceService; git: GitService }, info = scope.workspace.get().info): Promise<WorkspaceInfo> => {
    const snapshots = await Promise.all(info.repositories.map(async (repository) => ({
      repository,
      snapshot: await scope.git.status(true, repository.id).catch(() => null)
    })));
    const repositories = info.repositories.map((repository) => {
      const snapshot = snapshots.find((item) => item.repository.id === repository.id)?.snapshot;
      return { ...repository, changedFileCount: snapshot?.files.length ?? 0 };
    });
    const changedRepositoryCount = repositories.filter((repository) => (repository.changedFileCount ?? 0) > 0).length;
    const changedFileCount = repositories.reduce((total, repository) => total + (repository.changedFileCount ?? 0), 0);
    const currentId = info.git?.id;
    const enriched = {
      ...info,
      repositories,
      git: currentId ? repositories.find((repository) => repository.id === currentId) ?? null : null,
      changedRepositoryCount,
      changedFileCount
    };
    scope.workspace.get().info = enriched;
    return enriched;
  };
  const workspaceChangeSummary = async (workspacePath: string): Promise<WorkspaceChangeSummary> => {
    try {
      const workspace = new WorkspaceService();
      const git = new GitService(workspace);
      const info = await workspace.open(workspacePath);
      const enriched = await withChangeCounts({ workspace, git }, info);
      return {
        path: workspacePath,
        name: enriched.name,
        repositoryCount: enriched.repositories.length,
        changedRepositoryCount: enriched.changedRepositoryCount ?? 0,
        changedFileCount: enriched.changedFileCount ?? 0
      };
    } catch (error) {
      return {
        path: workspacePath,
        name: path.basename(workspacePath),
        repositoryCount: 0,
        changedRepositoryCount: 0,
        changedFileCount: 0,
        error: error instanceof AppError ? error.message : "无法读取工作区变更"
      };
    }
  };

  app.get<{ Querystring: { path?: string; showHidden?: string; showIgnored?: string } }>("/api/files/tree", async (request) => {
    const scope = session(request);
    let data = await scope.files.tree(request.query.path ?? "", request.query.showHidden !== "false");
    const repositories = scope.workspace.get().info.repositories;
    if (repositories.length) {
      const snapshots = await Promise.all(repositories.map(async (repository) => {
        const paths = data.map((entry) => ({ entry, repoPath: relativeToRepo(entry.path, repository.workspacePath) })).filter((item): item is { entry: typeof data[number]; repoPath: string } => item.repoPath !== null);
        const [snapshot, tracked] = await Promise.all([
          scope.git.status(true, repository.id).catch(() => null),
          scope.git.tracked(paths.map((item) => item.repoPath).filter(Boolean), repository.id).catch(() => new Set<string>())
        ]);
        return { repository, snapshot, tracked };
      }));
      if (request.query.showIgnored !== "true") {
        const ignored = new Set<string>();
        for (const { repository } of snapshots) {
          const paths = data.map((entry) => ({ entry, repoPath: relativeToRepo(entry.path, repository.workspacePath) })).filter((item): item is { entry: typeof data[number]; repoPath: string } => item.repoPath !== null && item.repoPath !== "");
          const repoIgnored = await scope.git.ignored(paths.map((item) => item.repoPath), repository.id).catch(() => new Set<string>());
          for (const item of paths) if (repoIgnored.has(item.repoPath)) ignored.add(item.entry.path);
        }
        data = data.filter((entry) => !ignored.has(entry.path));
      }
      for (const entry of data) {
        for (const { repository, snapshot, tracked } of snapshots) {
          if (entry.path === repository.workspacePath) {
            entry.gitTrackedState = "repository";
            entry.repositoryId = repository.id;
            entry.repositoryPath = "";
            entry.repositoryName = repository.name;
            entry.repositoryChangedFileCount = snapshot?.files.length ?? 0;
            entry.descendantChanged ||= entry.kind === "directory" && Boolean(snapshot?.files.length);
            continue;
          }
          const repoPath = relativeToRepo(entry.path, repository.workspacePath);
          if (repoPath !== null) {
            entry.repositoryId = repository.id;
            entry.repositoryPath = repoPath;
            entry.repositoryName = repository.name;
            const affected = snapshot?.files.filter((file) => file.path === repoPath || file.oldPath === repoPath || (entry.kind === "directory" && repoPath && (file.path.startsWith(`${repoPath}/`) || file.oldPath?.startsWith(`${repoPath}/`)))) ?? [];
            entry.descendantChanged ||= entry.kind === "directory" && affected.length > 0;
            const file = affected.find((item) => item.path === repoPath || item.oldPath === repoPath);
            if (file) entry.gitState = gitState(file);
            const trackedExact = tracked.has(repoPath);
            const trackedDescendant = entry.kind === "directory" && Array.from(tracked).some((filePath) => filePath.startsWith(`${repoPath}/`));
            const untracked = Boolean(file?.categories.includes("untracked"));
            const untrackedDescendant = entry.kind === "directory" && affected.some((item) => item.categories.includes("untracked"));
            entry.gitTrackedState = trackedExact || trackedDescendant ? "tracked" : untracked || untrackedDescendant ? "untracked" : "untracked";
          } else if (entry.kind === "directory" && insideOrSame(entry.path, repository.workspacePath) && snapshot?.files.length) {
            entry.descendantChanged = true;
          }
        }
        if (!entry.gitTrackedState) entry.gitTrackedState = "uncontrolled";
      }
    } else {
      for (const entry of data) entry.gitTrackedState = "uncontrolled";
    }
    return { data, requestId: request.id };
  });
  app.get<{ Querystring: { path: string } }>("/api/files/content", async (request) => ({ data: await session(request).files.read(request.query.path), requestId: request.id }));
  app.get<{ Querystring: { path: string } }>("/api/files/raw", async (request, reply) => {
    const target = await session(request).workspace.get().guard.resolveExisting(request.query.path);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new AppError(400, "NOT_A_FILE", "目标不是文件");
    if (info.size > 25 * 1024 * 1024) throw new AppError(413, "FILE_TOO_LARGE", "图片超过 25 MiB 预览限制");
    const extension = path.extname(request.query.path).toLowerCase();
    const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
    const mime = mimeTypes[extension];
    if (!mime) throw new AppError(415, "UNSUPPORTED_PREVIEW", "该文件类型不支持图片预览");
    return reply.header("content-type", mime).header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(createReadStream(target.absolute));
  });
  app.get<{ Querystring: { source: "worktree" | "index" | "head" | "commit"; path: string; hash?: string; repositoryId?: string } }>("/api/git/image", async (request, reply) => {
    const extension = path.extname(request.query.path).toLowerCase();
    const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
    const mime = mimeTypes[extension];
    if (!mime) throw new AppError(415, "UNSUPPORTED_PREVIEW", "该文件类型不支持图片预览");
    const buffer = await session(request).git.image(request.query.source, request.query.path, request.query.hash, request.query.repositoryId);
    return reply.header("content-type", mime).header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(buffer);
  });
  app.put<{ Body: { path: string; content: string; expectedVersion: string } }>("/api/files/content", async (request) => ({ data: await session(request).files.save(request.body.path, request.body.content, request.body.expectedVersion), requestId: request.id }));
  app.post<{ Body: { path: string; content?: string } }>("/api/files", async (request) => ({ data: await session(request).files.createFile(request.body.path, request.body.content), requestId: request.id }));
  app.post<{ Body: { path: string } }>("/api/directories", async (request) => { await session(request).files.createDirectory(request.body.path); return { data: null, requestId: request.id }; });
  app.patch<{ Body: { from: string; to: string } }>("/api/files/rename", async (request) => { await session(request).files.move(request.body.from, request.body.to); return { data: null, requestId: request.id }; });
  app.delete<{ Querystring: { path: string; recursive?: string; confirmed?: string } }>("/api/files", async (request) => { await session(request).files.remove(request.query.path, request.query.recursive === "true", request.query.confirmed === "true"); return { data: null, requestId: request.id }; });
  app.get<{ Querystring: { path: string } }>("/api/files/absolute-path", async (request) => ({ data: (await session(request).workspace.get().guard.resolveExisting(request.query.path)).absolute, requestId: request.id }));

  app.get<{ Querystring: { repositoryId?: string } }>("/api/git/repository", async (request) => { const scope = session(request); return { data: request.query.repositoryId ? scope.workspace.getRepository(request.query.repositoryId).repository : scope.workspace.get().info.git, requestId: request.id }; });
  app.get("/api/git/repositories", async (request) => {
    const scope = session(request);
    return { data: (await withChangeCounts(scope)).repositories, requestId: request.id };
  });
  app.post<{ Body: { repositoryId: string } }>("/api/git/repository/select", async (request) => {
    const scope = session(request);
    scope.git.invalidate();
    const info = await scope.workspace.selectRepository(request.body.repositoryId);
    return { data: await withChangeCounts(scope, info), requestId: request.id };
  });
  app.get<{ Querystring: { repositoryId?: string } }>("/api/git/status", async (request) => ({ data: await session(request).git.status(true, request.query.repositoryId), requestId: request.id }));
  app.get<{ Querystring: { repositoryId?: string } }>("/api/git/branches", async (request) => ({ data: await session(request).git.branches(request.query.repositoryId), requestId: request.id }));
  app.post<{ Body: { name: string; kind: "local" | "remote"; allowDirty?: boolean; repositoryId?: string } }>("/api/git/switch", async (request) => {
    const scope = session(request);
    const result = await scope.git.switchBranch(request.body.name, request.body.kind, Boolean(request.body.allowDirty), request.body.repositoryId);
    return { data: { ...result, workspace: await withChangeCounts(scope, result.workspace) }, requestId: request.id };
  });
  app.get<{ Querystring: { cursor?: string; limit?: string; repositoryId?: string } }>("/api/git/history", async (request) => ({ data: await session(request).git.history(request.query.cursor, Number(request.query.limit ?? 50), request.query.repositoryId), requestId: request.id }));
  app.get<{ Querystring: { cursor?: string; limit?: string; repositoryId?: string } }>("/api/git/graph", async (request) => ({ data: await session(request).git.graph(Number(request.query.cursor ?? 0), Number(request.query.limit ?? 100), request.query.repositoryId), requestId: request.id }));
  app.get<{ Params: { hash: string }; Querystring: { repositoryId?: string } }>("/api/git/commits/:hash", async (request) => ({ data: await session(request).git.commit(request.params.hash, request.query.repositoryId), requestId: request.id }));
  app.get<{ Querystring: { scope?: "working" | "staged" | "all"; path?: string; repositoryId?: string } }>("/api/git/diff", async (request) => ({ data: await session(request).git.diff(request.query.scope ?? "all", request.query.path, undefined, request.query.repositoryId), requestId: request.id }));
  app.get<{ Params: { hash: string }; Querystring: { path?: string; repositoryId?: string } }>("/api/git/diff/commits/:hash", async (request) => ({ data: await session(request).git.diff("commit", request.query.path, request.params.hash, request.query.repositoryId), requestId: request.id }));

  app.get<{ Querystring: { workspaceId: string; lastSequence?: string; sessionId?: string } }>("/api/events", { websocket: true }, (socket, request) => {
    const scope = session(request);
    const current = scope.workspace.get().info;
    if (request.query.workspaceId !== current.id) { socket.close(1008, "workspace mismatch"); return; }
    socket.send(JSON.stringify({ type: "connected", workspaceId: current.id, currentSequence: scope.hub.currentSequence() }));
    const remove = scope.hub.add(socket, current.id, Number(request.query.lastSequence ?? 0));
    socket.on("close", remove);
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(here, "../../web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" }, requestId: request.id }) : reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => { await Promise.all(Array.from(sessions.values()).map((scope) => scope.watcher.stop())); });
  return app;
}
