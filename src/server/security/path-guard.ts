import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { AppError } from "../errors.js";

export class PathGuard {
  constructor(private root: string) {}

  static async create(root: string) { return new PathGuard(await realpath(root)); }
  getRoot() { return this.root; }

  private validateRelative(relative: string) {
    if (relative.includes("\0") || path.isAbsolute(relative)) throw new AppError(400, "INVALID_PATH", "路径必须是工作区内的相对路径");
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.split("/").some((part) => part === "..")) throw new AppError(403, "PATH_OUTSIDE_WORKSPACE", "禁止访问工作区之外的路径");
    if (normalized === ".git" || normalized.startsWith(".git/")) throw new AppError(403, "GIT_INTERNAL_PATH_DENIED", "禁止通过文件接口访问 .git");
    return normalized === "." ? "" : normalized;
  }

  private ensureInside(target: string) {
    const rel = path.relative(this.root, target);
    if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) return;
    throw new AppError(403, "PATH_OUTSIDE_WORKSPACE", "禁止访问工作区之外的路径");
  }

  async resolveExisting(relative = "") {
    const normalized = this.validateRelative(relative);
    const candidate = path.resolve(this.root, normalized);
    this.ensureInside(candidate);
    let actual: string;
    try { actual = await realpath(candidate); } catch { throw new AppError(404, "PATH_NOT_FOUND", "文件或目录不存在"); }
    this.ensureInside(actual);
    return { absolute: actual, relative: normalized };
  }

  async resolveNew(relative: string) {
    const normalized = this.validateRelative(relative);
    if (!normalized) throw new AppError(400, "INVALID_PATH", "不能操作工作区根目录");
    const candidate = path.resolve(this.root, normalized);
    this.ensureInside(candidate);
    const parent = await realpath(path.dirname(candidate)).catch(() => { throw new AppError(404, "PATH_NOT_FOUND", "父目录不存在"); });
    this.ensureInside(parent);
    return { absolute: candidate, relative: normalized };
  }

  async kind(relative: string) {
    const target = await this.resolveExisting(relative);
    return { ...target, stat: await stat(target.absolute) };
  }
}
