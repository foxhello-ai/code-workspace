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
const windows = process.platform === "win32";
const powershell = "powershell.exe";
const redact = text => text.replace(/^(?:访问密码：|Access password:).*$/gm, "Access password: [redacted]");

function run(command, args, env, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out\n${redact(Buffer.concat(output).toString())}`)); }, timeout);
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      // Installer output contains a generated password; never expose it in test logs.
      const text = redact(Buffer.concat(output).toString());
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
  for (const name of ["code-workspace.mjs", "code-workspace.cmd"]) await copyFile(path.join(root, "bin", name), path.join(stage, "bin", name));
  await chmod(path.join(stage, "bin/code-workspace"), 0o755);
  await writeFile(path.join(stage, "dist/server/server/index.js"), `
const http = require("node:http");
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (process.env.CODE_WORKSPACE_INSTANCE_ID) response.setHeader("x-code-workspace-instance", process.env.CODE_WORKSPACE_INSTANCE_ID);
  response.end(JSON.stringify({ ok: true, version: ${JSON.stringify(version)} }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close());
`);
  const archive = path.join(directory, `${version}${windows ? ".zip" : ".tar.gz"}`);
  const result = windows
    ? await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:CODE_WORKSPACE_FIXTURE_STAGE -DestinationPath $env:CODE_WORKSPACE_FIXTURE_ARCHIVE"], { ...process.env, CODE_WORKSPACE_FIXTURE_STAGE: stage, CODE_WORKSPACE_FIXTURE_ARCHIVE: archive })
    : await run("tar", ["-czf", archive, "-C", path.dirname(stage), "code-workspace"], process.env);
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
    } else if (request.url.endsWith(".tar.gz") || request.url.endsWith(".zip")) response.end(archive);
    else { response.statusCode = 404; response.end(); }
  });
  const mirrorPort = await listen(server), port = await availablePort();
  const env = { ...process.env, CODE_WORKSPACE_HOME: path.join(directory, "app with spaces 中文"), CODE_WORKSPACE_BIN_DIR: path.join(directory, "bin with spaces 中文"), CODE_WORKSPACE_SKIP_PATH_UPDATE: "1", XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state"), CODE_WORKSPACE_RELEASE_DOWNLOAD_BASE: `http://127.0.0.1:${mirrorPort}`, CODE_WORKSPACE_RELEASE_REPOSITORY: "test/code-workspace", HOST: "127.0.0.1", PORT: String(port), NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", LC_ALL: "C", LANG: "C" };
  delete env.APP_PASSWORD;
  delete env.CODE_WORKSPACE_VERSION;
  const cli = path.join(env.CODE_WORKSPACE_BIN_DIR, `code-workspace${windows ? ".cmd" : ""}`);
  const cliRun = (command, overrides = env) => windows
    ? run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "& $env:CODE_WORKSPACE_TEST_CLI $env:CODE_WORKSPACE_TEST_ACTION; exit $LASTEXITCODE"], { ...overrides, CODE_WORKSPACE_TEST_CLI: cli, CODE_WORKSPACE_TEST_ACTION: command })
    : run(cli, [command], overrides);
  const configPath = windows ? path.join(env.CODE_WORKSPACE_HOME, "config/config.json") : path.join(directory, "config/code-workspace/config.env");
  try {
    await body({ directory, env, port, url: `http://127.0.0.1:${port}`, cli, cliRun, configPath, setArchive(value) { archive = value; }, corruptChecksum() { corrupt = true; }, install: () => windows
      ? run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/install.ps1")], env, 90_000)
      : run("sh", [path.join(root, "scripts/install.sh")], env, 90_000) });
  } finally {
    try {
      if (await stat(cli).catch(() => null)) { const result = await cliRun("stop"); assert.equal(result.code, 0, result.text); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally {
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
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
    const configPath = h.configPath;
    const config = await readFile(configPath, "utf8");
    if (windows) {
      assert.match(JSON.parse(config).APP_PASSWORD, /^[A-Za-z0-9_-]{32}$/);
      const acl = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:CODE_WORKSPACE_TEST_CONFIG).AreAccessRulesProtected"], { ...h.env, CODE_WORKSPACE_TEST_CONFIG: path.dirname(configPath) });
      assert.equal(acl.code, 0, acl.text); assert.match(acl.text, /True/);
    } else {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.match(config, /APP_PASSWORD=[A-Za-z0-9_-]{32}/);
    }
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal(await readFile(configPath, "utf8"), config);
    h.setArchive(newArchive);
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.1");
    assert.equal(await readFile(configPath, "utf8"), config);
    for (const command of ["status", "restart", "status", "stop", "start"]) {
      result = await h.cliRun(command);
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
    await assert.rejects(stat(path.join(h.env.CODE_WORKSPACE_HOME, windows ? "current.json" : "current")), { code: "ENOENT" });
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
    const config = await readFile(h.configPath, "utf8");
    const password = windows ? JSON.parse(config).APP_PASSWORD : config.match(/^APP_PASSWORD=(.+)$/m)[1];
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
    const installation = windows ? JSON.parse(await readFile(path.join(h.env.CODE_WORKSPACE_HOME, "current.json"), "utf8")).path : path.join(h.env.CODE_WORKSPACE_HOME, "current");
    await readFile(path.join(installation, "README.en.md"));
    // The release must be ready to run without a checkout, compiler, or npm install.
    await assert.rejects(stat(path.join(installation, "src")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(installation, "node_modules/typescript")), { code: "ENOENT" });
  });
});
