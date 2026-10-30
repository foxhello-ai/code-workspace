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
const powershell = process.env.CODE_WORKSPACE_TEST_POWERSHELL || "powershell.exe";
const redact = text => text.replace(/^(?:访问密码：|Access password:).*$/gm, "Access password: [redacted]");

function run(command, args, env, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    // Windows PowerShell must find its own modules when the test is run in pwsh.
    if (windows && command === powershell) for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "psmodulepath") delete childEnv[key];
    const child = spawn(command, args, { env: childEnv, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    let settled = false;
    let exitCode;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out (exit: ${exitCode ?? "pending"})\n${redact(Buffer.concat(output).toString())}`)); }, timeout);
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => output.push(chunk));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Installer output contains a generated password; never expose it in test logs.
      const text = redact(Buffer.concat(output).toString());
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, text });
    };
    child.on("close", finish);
    child.on("exit", code => {
      exitCode = code;
      clearTimeout(timer);
      // A detached Windows daemon can keep inherited pipe handles open after
      // PowerShell exits. Wait for buffered output, not the daemon's lifetime.
      setTimeout(() => finish(code), 100);
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
      ? run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/fixtures/install-without-acl-privileges.ps1"), "-Installer", path.join(root, "scripts/install.ps1")], env, 90_000)
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

async function windowsConfigAcl(env, configPath) {
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
function Describe-Acl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  @{
    protected = $acl.AreAccessRulesProtected
    owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
    rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags }
    })
  }
}
@{
  sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  directory = Describe-Acl (Split-Path -Parent $env:CODE_WORKSPACE_TEST_CONFIG)
  file = Describe-Acl $env:CODE_WORKSPACE_TEST_CONFIG
} | ConvertTo-Json -Depth 5 -Compress
`], { ...env, CODE_WORKSPACE_TEST_CONFIG: configPath });
  assert.equal(result.code, 0, result.text);
  const acl = JSON.parse(result.text.trim());
  assert.equal(acl.directory.protected, true);
  assert.deepEqual(acl.directory.rules, [{ sid: acl.sid, rights: 2032127, inherited: false, inheritance: 3 }]);
  assert.deepEqual(acl.file.rules, [{ sid: acl.sid, rights: 2032127, inherited: true, inheritance: 0 }]);
  return acl;
}

async function interceptDownloads(h, failures) {
  const curl = await run("sh", ["-c", "command -v curl"], h.env);
  assert.equal(curl.code, 0, curl.text);
  const wrapperDirectory = path.join(h.directory, "curl wrapper");
  const log = path.join(h.directory, "curl-requests.json");
  await mkdir(wrapperDirectory);
  await writeFile(path.join(wrapperDirectory, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const uri = args.at(-1);
const invoke = () => { const result = spawnSync(process.env.CODE_WORKSPACE_TEST_REAL_CURL, args, { stdio: "inherit" }); process.exit(result.status ?? 1); };
if (!uri.includes("/releases/")) invoke();
const log = process.env.CODE_WORKSPACE_TEST_CURL_LOG;
const requests = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, "utf8")) : [];
const kind = uri.endsWith(".sha256") ? "checksum" : "archive";
const previous = requests.filter(request => request.kind === kind).length;
const destination = args[args.indexOf("-o") + 1];
const http1 = args.includes("--http1.1");
requests.push({ kind, http1, destination, partialExisted: fs.existsSync(destination) });
fs.writeFileSync(log, JSON.stringify(requests));
const failure = !http1 ? { code: 16, http: "000" } : JSON.parse(process.env.CODE_WORKSPACE_TEST_CURL_FAILURES)[kind]?.[previous];
if (failure) {
  fs.writeFileSync(destination, "incomplete download");
  if (args.includes("--write-out")) process.stdout.write(failure.http ?? "000");
  console.error("Injected curl transfer failure: " + failure.code);
  process.exit(failure.code);
}
invoke();
`);
  await chmod(path.join(wrapperDirectory, "curl"), 0o755);
  Object.assign(h.env, {
    PATH: `${wrapperDirectory}${path.delimiter}${h.env.PATH}`,
    CODE_WORKSPACE_TEST_REAL_CURL: curl.text.trim(),
    CODE_WORKSPACE_TEST_CURL_LOG: log,
    CODE_WORKSPACE_TEST_CURL_FAILURES: JSON.stringify(failures)
  });
  return async () => JSON.parse(await readFile(log, "utf8"));
}

test("shell installer uses HTTP/1.1 and retries incomplete downloads and HTTP service errors", { skip: windows, timeout: 60_000 }, async () => {
  await harness(async h => {
    h.setArchive(await fixtureArchive(h.directory, "1.0.0"));
    const requests = await interceptDownloads(h, { archive: [{ code: 18 }, { code: 22, http: "503" }], checksum: [{ code: 56 }] });
    const result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /正在重试/);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.0");
    const calls = await requests();
    assert.deepEqual(calls.map(call => call.kind), ["archive", "archive", "archive", "checksum", "checksum"]);
    assert.ok(calls.every(call => call.http1 && !call.partialExisted && call.destination.endsWith(".part")));
    for (const call of calls) await assert.rejects(stat(call.destination), { code: "ENOENT" });
  });
});

test("shell installer limits failed transfer retries and preserves a running installation", { skip: windows, timeout: 60_000 }, async () => {
  await harness(async h => {
    h.setArchive(await fixtureArchive(h.directory, "1.0.0"));
    const installed = await h.install();
    assert.equal(installed.code, 0, installed.text);
    const config = await readFile(h.configPath, "utf8");
    const pidPath = path.join(h.env.XDG_STATE_HOME, "code-workspace/server.pid");
    const pid = await readFile(pidPath, "utf8");
    const requests = await interceptDownloads(h, { archive: Array.from({ length: 4 }, () => ({ code: 16 })) });
    const failed = await h.install();
    assert.notEqual(failed.code, 0);
    assert.match(failed.text, /下载发布包失败/);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.0");
    assert.equal(await readFile(h.configPath, "utf8"), config);
    assert.equal(await readFile(pidPath, "utf8"), pid);
    const calls = await requests();
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.kind === "archive" && call.http1 && !call.partialExisted));
    for (const call of calls) await assert.rejects(stat(call.destination), { code: "ENOENT" });
  });
});

test("shell installer does not retry a missing release or create an installation", { skip: windows, timeout: 30_000 }, async () => {
  await harness(async h => {
    const requests = await interceptDownloads(h, { archive: [{ code: 22, http: "404" }] });
    const result = await h.install();
    assert.notEqual(result.code, 0);
    assert.equal((await requests()).length, 1);
    await assert.rejects(stat(h.configPath), { code: "ENOENT" });
    await assert.rejects(stat(path.join(h.env.CODE_WORKSPACE_HOME, "current")), { code: "ENOENT" });
  });
});

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
    let originalAcl;
    if (windows) {
      assert.match(result.text, /Verified: installer token has no security, backup, restore, or take-ownership privileges\./);
      assert.match(JSON.parse(config).APP_PASSWORD, /^[A-Za-z0-9_-]{32}$/);
      originalAcl = await windowsConfigAcl(h.env, configPath);
    } else {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.match(config, /APP_PASSWORD=[A-Za-z0-9_-]{32}/);
    }
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal(await readFile(configPath, "utf8"), config);
    if (windows) assert.deepEqual(await windowsConfigAcl(h.env, configPath), originalAcl);
    h.setArchive(newArchive);
    result = await h.install();
    assert.equal(result.code, 0, result.text);
    assert.equal((await (await fetch(`${h.url}/health`)).json()).version, "1.0.1");
    assert.equal(await readFile(configPath, "utf8"), config);
    if (windows) assert.deepEqual(await windowsConfigAcl(h.env, configPath), originalAcl);
    for (const command of ["status", "restart", "status", "stop", "start"]) {
      result = await h.cliRun(command, windows ? { ...h.env, CODE_WORKSPACE_HOME: "", HOST: "", PORT: "", APP_PASSWORD: "" } : h.env);
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
