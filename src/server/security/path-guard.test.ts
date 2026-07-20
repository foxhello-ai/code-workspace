import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    expect((await guard.resolveExisting("ok.txt")).absolute).toBe(await realpath(path.join(root, "ok.txt")));
    await expect(guard.resolveExisting("../secret")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(guard.resolveExisting(".git/config")).rejects.toMatchObject({ code: "GIT_INTERNAL_PATH_DENIED" });
  });

  it("allows workspace symlinks to resolve to their targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-")); roots.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-")); roots.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    const guard = await PathGuard.create(root);
    expect((await guard.resolveExisting("link.txt")).absolute).toBe(await realpath(path.join(outside, "secret.txt")));
  });
});
