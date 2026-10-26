import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manager = fileURLToPath(new URL("../bin/code-workspace.mjs", import.meta.url));
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function harness(body) {
  const directory = await mkdtemp(path.join(tmpdir(), "cw-manager spaces 中文-"));
  const release = path.join(directory, "versions", "1.0.0");
  const entry = path.join(release, "dist/server/server/index.js");
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.join(directory, "config"));
  await writeFile(path.join(directory, "current.json"), JSON.stringify({ version: "1.0.0", path: release }));
  await writeFile(path.join(directory, "config/config.json"), JSON.stringify({ HOST: "127.0.0.1", PORT: port, APP_PASSWORD: "test-password" }));
  await writeFile(entry, `
const { createServer } = require("node:http");
const server = createServer((request, response) => {
  response.setHeader("x-code-workspace-instance", process.env.CODE_WORKSPACE_INSTANCE_ID);
  response.end(JSON.stringify({ ok: true }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close());
`);
  const env = { ...process.env, CODE_WORKSPACE_HOME: directory };
  for (const key of ["HOST", "PORT", "APP_PASSWORD"]) delete env[key];
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, command], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("Service command timed out")); }, 45_000);
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => chunks.push(chunk));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, text: Buffer.concat(chunks).toString() }); });
  });
  const stateFile = path.join(directory, "state/server.json");
  try { await body({ directory, run, stateFile, entry, port }); }
  finally {
    const result = await run("stop");
    assert.equal(result.code, 0, result.text);
    await rm(directory, { recursive: true, force: true });
  }
}

test("background manager supports idempotent start, status, logs, restart and stop", { timeout: 90_000 }, async () => {
  await harness(async h => {
    for (const command of ["start", "status", "logs"]) { const result = await h.run(command); assert.equal(result.code, 0, result.text); }
    const first = JSON.parse(await readFile(h.stateFile, "utf8"));
    assert.equal((await h.run("start")).code, 0);
    assert.equal(JSON.parse(await readFile(h.stateFile, "utf8")).pid, first.pid);
    const restarted = await h.run("restart"); assert.equal(restarted.code, 0, restarted.text);
    assert.notEqual(JSON.parse(await readFile(h.stateFile, "utf8")).instance, first.instance);
    assert.equal((await h.run("stop")).code, 0);
    assert.equal((await h.run("status")).code, 1);
  });
});

test("a stale PID never stops an unrelated process", { timeout: 30_000 }, async () => {
  await harness(async h => {
    await mkdir(path.dirname(h.stateFile), { recursive: true });
    await writeFile(h.stateFile, JSON.stringify({ pid: process.pid, instance: randomUUID(), port: h.port }));
    const stopped = await h.run("stop"); assert.equal(stopped.code, 0, stopped.text);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    await assert.rejects(stat(h.stateFile), { code: "ENOENT" });
  });
});

test("an occupied port is rejected even if its health endpoint says ok", { timeout: 30_000 }, async () => {
  await harness(async h => {
    const other = createServer((_request, response) => response.end('{"ok":true}'));
    await new Promise(resolve => other.listen(h.port, "127.0.0.1", resolve));
    try {
      const started = await h.run("start");
      assert.equal(started.code, 1); assert.match(started.text, /already in use/);
      await assert.rejects(stat(h.stateFile), { code: "ENOENT" });
    } finally { await new Promise(resolve => other.close(resolve)); }
  });
});

test("a failed background launch reports failure and removes its PID state", { timeout: 30_000 }, async () => {
  await harness(async h => {
    await writeFile(h.entry, 'process.exit(2);');
    const started = await h.run("start");
    assert.equal(started.code, 1); assert.match(started.text, /did not become ready/);
    await assert.rejects(stat(h.stateFile), { code: "ENOENT" });
  });
});
