import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveFile = process.env.CODE_WORKSPACE_TEST_ARCHIVE;

function run(command, args, env, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out`)); }, timeout);
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      // Installer output contains a generated password; never expose it in test logs.
      const text = Buffer.concat(output).toString().replace(/^访问密码：.*$/gm, "访问密码：[redacted]");
      resolve({ code, text });
    });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixtureArchive(directory, version) {
  const stage = path.join(directory, version, "code-workspace");
  await mkdir(path.join(stage, "dist/server/server"), { recursive: true });
  await mkdir(path.join(stage, "bin"));
  await writeFile(path.join(stage, "package.json"), JSON.stringify({ version }));
  await copyFile(path.join(root, "bin/code-workspace"), path.join(stage, "bin/code-workspace"));
  await chmod(path.join(stage, "bin/code-workspace"), 0o755);
  await writeFile(path.join(stage, "dist/server/server/index.js"), `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true, version: ${JSON.stringify(version)} }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close());
`);
  const archive = path.join(directory, `${version}.tar.gz`);
  const result = await run("tar", ["-czf", archive, "-C", path.dirname(stage), "code-workspace"], process.env);
  assert.equal(result.code, 0, result.text);
  return readFile(archive);
}

async function harness(body) {
  const directory = await mkdtemp(path.join(tmpdir(), "code-workspace-install-test-"));
  let archive = Buffer.alloc(0), corrupt = false;
  const server = createServer((request, response) => {
    if (request.url.endsWith(".sha256")) {
      const checksum = corrupt ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex");
      response.end(`${checksum}  code-workspace-latest.tar.gz\n`);
    } else if (request.url.endsWith(".tar.gz")) response.end(archive);
    else { response.statusCode = 404; response.end(); }
  });
  const mirrorPort = await listen(server), port = await availablePort();
  const env = { ...process.env, CODE_WORKSPACE_HOME: path.join(directory, "app"), CODE_WORKSPACE_BIN_DIR: path.join(directory, "bin"), XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state"), CODE_WORKSPACE_RELEASE_DOWNLOAD_BASE: `http://127.0.0.1:${mirrorPort}`, CODE_WORKSPACE_RELEASE_REPOSITORY: "test/code-workspace", HOST: "127.0.0.1", PORT: String(port), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", LC_ALL: "C", LANG: "C" };
  delete env.APP_PASSWORD;
  delete env.CODE_WORKSPACE_VERSION;
  const cli = path.join(directory, "bin/code-workspace");
  try {
    await body({ directory, env, port, url: `http://127.0.0.1:${port}`, cli, setArchive(value) { archive = value; }, corruptChecksum() { corrupt = true; }, install: () => run("sh", [path.join(root, "scripts/install.sh")], env, 90_000) });
  } finally {
    try {
      const result = await run(cli, ["stop"], env);
      assert.equal(result.code, 0, result.text);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally {
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
}

test("installer starts a fresh release, preserves config on reinstall, and runs the upgraded version", { timeout: 120_000 }, async () => {
  await harness(async h => {
    const oldArchive = await fixtureArchive(h.directory, "1.0.0");
    const newArchive = await fixtureArchive(h.directory, "1.0.1");
    h.setArchive(oldArchive);
    let result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.0");
    const configPath = path.join(h.directory, "config/code-workspace/config.env");
    const config = await readFile(configPath, "utf8");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.match(config, /APP_PASSWORD=[A-Za-z0-9_-]{32}/);
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal(await readFile(configPath, "utf8"), config);
    h.setArchive(newArchive);
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.1");
    assert.equal(await readFile(configPath, "utf8"), config);
    for (const command of ["status", "restart", "status", "stop", "start"]) {
      result = await run(h.cli, [command], h.env);
      assert.equal(result.code, 0, result.text);
    }
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.1");
  });
});

test("installer rejects an archive with an incorrect checksum", { timeout: 30_000 }, async () => {
  await harness(async h => {
    h.setArchive(await fixtureArchive(h.directory, "1.0.0"));
    h.corruptChecksum();
    const result = await h.install();
    assert.notEqual(result.code, 0);
    assert.match(result.text, /SHA-256/);
    await assert.rejects(stat(path.join(h.directory, "app/current")), { code: "ENOENT" });
  });
});

test("production archive installs with bundled dependencies and serves authenticated Git APIs", { skip: !archiveFile, timeout: 120_000 }, async () => {
  await harness(async h => {
    h.setArchive(await readFile(path.resolve(root, archiveFile)));
    const result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.deepEqual(await (await fetch(`${h.url}/health`)).json(), { ok: true });
    const page = await fetch(h.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
    assert.ok(assets.length > 0);
    for (const asset of assets) assert.equal((await fetch(h.url + asset)).status, 200);
    assert.equal((await fetch(`${h.url}/api/workspace`)).status, 401);
    const config = await readFile(path.join(h.directory, "config/code-workspace/config.env"), "utf8");
    const password = config.match(/^APP_PASSWORD=(.+)$/m)[1];
    const login = await fetch(`${h.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const headers = { cookie: login.headers.get("set-cookie").split(";")[0], "content-type": "application/json" };
    const workspace = path.join(h.directory, "workspace");
    await mkdir(workspace);
    for (const args of [["init", "-q", "--initial-branch=main", workspace], ["-C", workspace, "config", "user.name", "Installer Test"], ["-C", workspace, "config", "user.email", "installer@example.invalid"], ["-C", workspace, "remote", "add", "origin", "git@example.invalid:team/project.git"]]) {
      const git = await run("git", args, h.env); assert.equal(git.code, 0, git.text);
    }
    const open = await fetch(`${h.url}/api/workspace/open`, { method: "POST", headers, body: JSON.stringify({ path: workspace }) });
    assert.equal(open.status, 200);
    const overview = await fetch(`${h.url}/api/git/worktrees`, { headers });
    assert.equal(overview.status, 200);
    const groups = (await overview.json()).data.groups;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].remote.primaryUrl, "git@example.invalid:team/project.git");
    const graph = await fetch(`${h.url}/api/git/graph`, { headers });
    assert.equal(graph.status, 200);
    assert.equal((await graph.json()).data.scope, "all");
    await readFile(path.join(h.directory, "app/current/README.en.md"));
  });
});
