import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathGuard } from "./path-guard.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PathGuard", () => {
  it("allows workspace files and rejects traversal and .git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-")); roots.push(root);
    await writeFile(path.join(root, "ok.txt"), "ok");
    await mkdir(path.join(root, ".git"));
    const guard = await PathGuard.create(root);
    expect((await guard.resolveExisting("ok.txt")).absolute).toBe(path.join(root, "ok.txt"));
    await expect(guard.resolveExisting("../secret")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(guard.resolveExisting(".git/config")).rejects.toMatchObject({ code: "GIT_INTERNAL_PATH_DENIED" });
  });

  it("rejects symlinks escaping the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-")); roots.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-")); roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    const guard = await PathGuard.create(root);
    await expect(guard.resolveExisting("link.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });
});
