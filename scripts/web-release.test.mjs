import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { publishWebRelease, inheritWebReleases, rollbackWebRelease } from "../bin/web-release.mjs";

async function harness(body) {
  const directory = await mkdtemp(path.join(tmpdir(), "cw-web-release spaces 中文-"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const root = path.join(directory, "live");
  async function build(version, hash = String(version).padStart(8, "0")) {
    const source = path.join(directory, `build-${version}`);
    await mkdir(path.join(source, "assets"), { recursive: true });
    await mkdir(path.join(source, ".vite"));
    const entry = `assets/index-${hash}.js`, chunk = `assets/WorkspaceRoot-${hash}.js`;
    await writeFile(path.join(source, "index.html"), `<script type="module" src="/${entry}"></script>`);
    const contents = {
      [entry]: `export const load = () => import("./WorkspaceRoot-${hash}.js");`,
      [chunk]: `export default ${version};`
    };
    for (const [name, content] of Object.entries(contents)) {
      await writeFile(path.join(source, name), content);
      await writeFile(path.join(source, `${name}.gz`), gzipSync(content));
      await writeFile(path.join(source, `${name}.br`), brotliCompressSync(content));
    }
    await writeFile(path.join(source, ".vite/manifest.json"), JSON.stringify({ "index.html": { file: entry, isEntry: true, dynamicImports: ["WorkspaceRoot.tsx"] }, "WorkspaceRoot.tsx": { file: chunk, isDynamicEntry: true } }));
    return { source, entry, chunk, contents };
  }
  try { await body({ directory, root, build }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("a module loaded before publication can still lazy-import its original chunk afterwards", async () => {
  await harness(async ({ root, build }) => {
    const old = await build(1);
    await publishWebRelease(old.source, root);
    const client = await import(pathToFileURL(path.join(root, old.entry)).href);
    const next = await build(2);
    await publishWebRelease(next.source, root);
    assert.equal((await client.load()).default, 1);
    for (const release of [old, next]) {
      assert.equal(await readFile(path.join(root, release.chunk), "utf8"), release.contents[release.chunk]);
      assert.equal(gunzipSync(await readFile(path.join(root, `${release.chunk}.gz`))).toString(), release.contents[release.chunk]);
      assert.equal(brotliDecompressSync(await readFile(path.join(root, `${release.chunk}.br`))).toString(), release.contents[release.chunk]);
    }
    assert.match(await readFile(path.join(root, "index.html"), "utf8"), /00000002/);
  });
});

test("retains three distinct builds and rolls back using recorded HTML and exact resource names", async () => {
  await harness(async ({ root, build }) => {
    const releases = [];
    for (let version = 1; version <= 4; version++) {
      const release = await build(version);
      release.id = await publishWebRelease(release.source, root);
      releases.push(release);
    }
    await assert.rejects(readFile(path.join(root, releases[0].chunk)), { code: "ENOENT" });
    for (const release of releases.slice(1)) assert.equal(await readFile(path.join(root, release.chunk), "utf8"), release.contents[release.chunk]);
    await rollbackWebRelease(root, releases[1].id);
    assert.equal(await readFile(path.join(root, "index.html"), "utf8"), await readFile(path.join(releases[1].source, "index.html"), "utf8"));
    await assert.rejects(rollbackWebRelease(root, releases[0].id), /outside the retained/);
    // Rebuilding an identical version must not evict another retained version.
    await publishWebRelease(releases[3].source, root);
    assert.equal(JSON.parse(await readFile(`${root}.releases/history.json`, "utf8")).length, 3);
    await readFile(path.join(root, releases[1].chunk));
  });
});

test("rejects missing or incorrectly cased chunks before switching the live HTML", async () => {
  await harness(async ({ root, build }) => {
    const old = await build(1);
    await publishWebRelease(old.source, root);
    const next = await build(2);
    const manifestFile = path.join(next.source, ".vite/manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest["WorkspaceRoot.tsx"].file = next.chunk.replace("WorkspaceRoot", "workspaceRoot");
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(publishWebRelease(next.source, root), /case mismatch/);
    assert.equal(await readFile(path.join(root, "index.html"), "utf8"), await readFile(path.join(old.source, "index.html"), "utf8"));
    await assert.rejects(readFile(path.join(root, next.entry)), { code: "ENOENT" });
  });
});

test("never overwrites an immutable URL with different content", async () => {
  await harness(async ({ root, build }) => {
    const old = await build(1);
    await publishWebRelease(old.source, root);
    const next = await build(2, "00000001");
    await assert.rejects(publishWebRelease(next.source, root), /Immutable asset collision/);
    assert.equal((await import(pathToFileURL(path.join(root, old.entry)).href)).load instanceof Function, true);
    assert.equal(await readFile(path.join(root, old.chunk), "utf8"), old.contents[old.chunk]);
  });
});

test("bootstraps the currently deployed assets even when an older build has no manifest", async () => {
  await harness(async ({ root, build }) => {
    const old = await build(1);
    await mkdir(root);
    const { cp } = await import("node:fs/promises");
    await cp(old.source, root, { recursive: true });
    await rm(path.join(root, ".vite"), { recursive: true });
    const client = await import(pathToFileURL(path.join(root, old.entry)).href);
    await publishWebRelease((await build(2)).source, root);
    assert.equal((await client.load()).default, 1);
  });
});

test("installer inheritance carries two prior builds forward and also supports a version rollback", async () => {
  await harness(async ({ directory, root, build }) => {
    const releases = [];
    let previous = path.join(directory, "not-installed-yet");
    for (let version = 1; version <= 4; version++) {
      const release = await build(version);
      await publishWebRelease(release.source, release.source + "-installed");
      const target = release.source + "-installed";
      await inheritWebReleases(previous, target);
      await inheritWebReleases(target, target); // Reinstall is a no-op.
      releases.push({ ...release, target });
      for (const retained of releases.slice(-3)) await readFile(path.join(target, retained.chunk));
      previous = target;
    }
    await assert.rejects(readFile(path.join(previous, releases[0].chunk)), { code: "ENOENT" });
    await inheritWebReleases(previous, releases[2].target);
    await readFile(path.join(releases[2].target, releases[3].chunk));
    assert.match(await readFile(path.join(releases[2].target, "index.html"), "utf8"), /00000003/);
    assert.equal(await readFile(path.join(previous, releases[3].chunk), "utf8"), releases[3].contents[releases[3].chunk]);
  });
});

test("concurrent publishers fail closed without removing the other publisher's lock", async () => {
  await harness(async ({ root, build }) => {
    const lock = path.join(`${root}.releases`, "publish.lock");
    await mkdir(lock, { recursive: true });
    await assert.rejects(publishWebRelease((await build(1)).source, root), /Another static publication/);
    await writeFile(path.join(lock, "owner-still-holds-lock"), "yes");
  });
});

test("the installer CLI also runs when reached through a symlink or Windows junction", async () => {
  await harness(async ({ directory, root, build }) => {
    const old = await build(1), next = await build(2);
    await publishWebRelease(old.source, root);
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");
    const linked = path.join(directory, "linked-bin");
    await symlink(bin, linked, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [path.join(linked, "web-release.mjs"), "inherit", root, next.source], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(path.join(next.source, old.chunk), "utf8"), old.contents[old.chunk]);
  });
});

test("an old on-disk Vite manifest cannot invalidate the new serving directory after old assets expire", async () => {
  await harness(async ({ root, build }) => {
    const { cp } = await import("node:fs/promises");
    await cp((await build(1)).source, root, { recursive: true });
    for (let version = 2; version <= 5; version++) await publishWebRelease((await build(version)).source, root);
    assert.match(await readFile(path.join(root, "index.html"), "utf8"), /00000005/);
  });
});
