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

export async function buildApp(options: { disableAuth?: boolean } = {}) {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024, genReqId: () => crypto.randomUUID() });
  await app.register(websocket);
  const workspace = new WorkspaceService();
  const git = new GitService(workspace);
  const hub = new EventHub();
  const watcher = new WatchService(workspace, git, hub);
  const auth = new AuthService();
  const files = new FileService(workspace, () => null);
  workspace.onChange = async (context) => { await watcher.stop(); git.invalidate(); hub.clear(); if (context) await watcher.start(); };

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
  app.post<{ Body: { path: string } }>("/api/workspace/open", async (request) => ({ data: await workspace.open(request.body.path), requestId: request.id }));
  app.get("/api/workspace", async (request) => ({ data: workspace.get().info, requestId: request.id }));
  app.post("/api/workspace/close", async (request) => { await workspace.close(); return { data: null, requestId: request.id }; });

  app.get<{ Querystring: { path?: string; showHidden?: string; showIgnored?: string } }>("/api/files/tree", async (request) => {
    let data = await files.tree(request.query.path ?? "", request.query.showHidden !== "false");
    if (workspace.get().info.git) {
      if (request.query.showIgnored !== "true") {
        const ignored = await git.ignored(data.map((entry) => entry.path));
        data = data.filter((entry) => !ignored.has(entry.path));
      }
      const snapshot = await git.status();
      for (const entry of data) {
        const affected = snapshot.files.filter((file) => file.path === entry.path || file.oldPath === entry.path || (entry.kind === "directory" && (file.path.startsWith(`${entry.path}/`) || file.oldPath?.startsWith(`${entry.path}/`))));
        entry.descendantChanged = entry.kind === "directory" && affected.length > 0;
        const file = affected.find((item) => item.path === entry.path || item.oldPath === entry.path);
        if (!file) continue;
        if (file.categories.includes("conflicted")) entry.gitState = "conflicted";
        else if (file.categories.includes("untracked")) entry.gitState = "untracked";
        else { const code = file.worktreeStatus !== "." ? file.worktreeStatus : file.indexStatus; entry.gitState = code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified"; }
      }
    }
    return { data, requestId: request.id };
  });
  app.get<{ Querystring: { path: string } }>("/api/files/content", async (request) => ({ data: await files.read(request.query.path), requestId: request.id }));
  app.get<{ Querystring: { path: string } }>("/api/files/raw", async (request, reply) => {
    const target = await workspace.get().guard.resolveExisting(request.query.path);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new AppError(400, "NOT_A_FILE", "目标不是文件");
    if (info.size > 25 * 1024 * 1024) throw new AppError(413, "FILE_TOO_LARGE", "图片超过 25 MiB 预览限制");
    const extension = path.extname(request.query.path).toLowerCase();
    const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
    const mime = mimeTypes[extension];
    if (!mime) throw new AppError(415, "UNSUPPORTED_PREVIEW", "该文件类型不支持图片预览");
    return reply.header("content-type", mime).header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(createReadStream(target.absolute));
  });
  app.get<{ Querystring: { source: "worktree" | "index" | "head" | "commit"; path: string; hash?: string } }>("/api/git/image", async (request, reply) => {
    const extension = path.extname(request.query.path).toLowerCase();
    const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon" };
    const mime = mimeTypes[extension];
    if (!mime) throw new AppError(415, "UNSUPPORTED_PREVIEW", "该文件类型不支持图片预览");
    const buffer = await git.image(request.query.source, request.query.path, request.query.hash);
    return reply.header("content-type", mime).header("cache-control", "no-store").header("x-content-type-options", "nosniff").send(buffer);
  });
  app.put<{ Body: { path: string; content: string; expectedVersion: string } }>("/api/files/content", async (request) => ({ data: await files.save(request.body.path, request.body.content, request.body.expectedVersion), requestId: request.id }));
  app.post<{ Body: { path: string; content?: string } }>("/api/files", async (request) => ({ data: await files.createFile(request.body.path, request.body.content), requestId: request.id }));
  app.post<{ Body: { path: string } }>("/api/directories", async (request) => { await files.createDirectory(request.body.path); return { data: null, requestId: request.id }; });
  app.patch<{ Body: { from: string; to: string } }>("/api/files/rename", async (request) => { await files.move(request.body.from, request.body.to); return { data: null, requestId: request.id }; });
  app.delete<{ Querystring: { path: string; recursive?: string; confirmed?: string } }>("/api/files", async (request) => { await files.remove(request.query.path, request.query.recursive === "true", request.query.confirmed === "true"); return { data: null, requestId: request.id }; });
  app.get<{ Querystring: { path: string } }>("/api/files/absolute-path", async (request) => ({ data: (await workspace.get().guard.resolveExisting(request.query.path)).absolute, requestId: request.id }));

  app.get("/api/git/repository", async (request) => ({ data: workspace.get().info.git, requestId: request.id }));
  app.get("/api/git/status", async (request) => ({ data: await git.status(), requestId: request.id }));
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/api/git/history", async (request) => ({ data: await git.history(request.query.cursor, Number(request.query.limit ?? 50)), requestId: request.id }));
  app.get<{ Params: { hash: string } }>("/api/git/commits/:hash", async (request) => ({ data: await git.commit(request.params.hash), requestId: request.id }));
  app.get<{ Querystring: { scope?: "working" | "staged" | "all"; path?: string } }>("/api/git/diff", async (request) => ({ data: await git.diff(request.query.scope ?? "all", request.query.path), requestId: request.id }));
  app.get<{ Params: { hash: string }; Querystring: { path?: string } }>("/api/git/diff/commits/:hash", async (request) => ({ data: await git.diff("commit", request.query.path, request.params.hash), requestId: request.id }));

  app.get<{ Querystring: { workspaceId: string; lastSequence?: string } }>("/api/events", { websocket: true }, (socket, request) => {
    const current = workspace.get().info;
    if (request.query.workspaceId !== current.id) { socket.close(1008, "workspace mismatch"); return; }
    socket.send(JSON.stringify({ type: "connected", workspaceId: current.id, currentSequence: hub.currentSequence() }));
    const remove = hub.add(socket, current.id, Number(request.query.lastSequence ?? 0));
    socket.on("close", remove);
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(here, "../../web");
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.status(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" }, requestId: request.id }) : reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => watcher.stop());
  return app;
}
