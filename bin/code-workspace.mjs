import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managerDirectory = path.dirname(fileURLToPath(import.meta.url));
const installationFile = path.join(managerDirectory, "installation.json");
const installedHome = existsSync(installationFile) ? JSON.parse(readFileSync(installationFile, "utf8")).appHome : path.join(managerDirectory, "..");
const appHome = path.resolve(process.env.CODE_WORKSPACE_HOME || installedHome);
const configFile = path.join(appHome, "config", "config.json");
const stateDir = path.join(appHome, "state");
const stateFile = path.join(stateDir, "server.json");
const logFile = path.join(stateDir, "server.log");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await readFile(file, "utf8"));

async function settings() {
  const stored = await json(configFile);
  const values = Object.fromEntries(["HOST", "PORT", "APP_PASSWORD"].map(key => [key, process.env[key] || stored[key]]));
  if (!values.APP_PASSWORD) throw new Error(`Set APP_PASSWORD in ${configFile}.`);
  if (!Number.isInteger(Number(values.PORT)) || Number(values.PORT) < 1 || Number(values.PORT) > 65535) throw new Error("PORT must be between 1 and 65535.");
  return values;
}

async function readState() {
  try { return await json(stateFile); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function alive(serverProcessId) {
  try { process.kill(serverProcessId, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function managed(state) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0 || !/^[a-f0-9-]{36}$/.test(state.instance)) return false;
  if (!alive(state.pid)) return false;
  const powershellEnv = { ...process.env, CODE_WORKSPACE_PROCESS_ID: String(state.pid) };
  for (const key of Object.keys(powershellEnv)) if (key.toLowerCase() === "psmodulepath") delete powershellEnv[key];
  // Check the instance argument before stopping a process; a stale PID may have been reused.
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:CODE_WORKSPACE_PROCESS_ID)).CommandLine"], { env: powershellEnv, encoding: "utf8", windowsHide: true, timeout: 10_000 })
    : spawnSync("ps", ["-ww", "-p", String(state.pid), "-o", "args="], { encoding: "utf8", timeout: 5000 });
  if (result.error || (result.status !== 0 && alive(state.pid))) throw new Error("Cannot verify the managed process identity; no process was stopped.");
  return result.stdout?.includes(`--code-workspace-instance=${state.instance}`) ?? false;
}

async function ready(state) {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && response.headers.get("x-code-workspace-instance") === state.instance && (await response.json()).ok === true;
  } catch { return false; }
}

async function start() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or later is required.");
  const previous = await readState();
  if (managed(previous)) {
    if (!await ready(previous)) throw new Error(`The service is running but not ready. Check ${logFile}.`);
    console.log(`Code Workspace is running: http://127.0.0.1:${previous.port}`);
    return;
  }
  const current = await json(path.join(appHome, "current.json"));
  const entry = path.join(current.path, "dist", "server", "server", "index.js");
  if (!existsSync(entry)) throw new Error("The installed release is incomplete. Run the installer again.");
  const values = await settings();
  // A healthy service on this port could belong to a different installation.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${values.PORT} is already in use. Stop its service or change PORT in ${configFile}.`)));
    probe.listen(Number(values.PORT), values.HOST, () => probe.close(resolve));
  });
  await mkdir(stateDir, { recursive: true });
  const instance = randomUUID();
  const output = openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [entry, `--code-workspace-instance=${instance}`], {
      cwd: current.path, detached: true, windowsHide: true,
      env: { ...process.env, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])), CODE_WORKSPACE_INSTANCE_ID: instance },
      stdio: ["ignore", output, output]
    });
  } finally { closeSync(output); }
  let launchError;
  child.on("error", error => { launchError = error; });
  child.unref();
  const state = { pid: child.pid, instance, port: Number(values.PORT), version: current.version };
  try {
    if (!state.pid) throw new Error("Could not start Node.js.");
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchError || !alive(state.pid)) break;
      if (await ready(state)) {
        console.log(`Code Workspace started: http://127.0.0.1:${state.port}`);
        return;
      }
      await sleep(250);
    }
    throw new Error(`The service did not become ready. Check ${logFile}.`);
  } catch (error) {
    // This is our just-created child, so it is safe to terminate it on startup failure.
    child.kill();
    await rm(stateFile, { force: true });
    throw error;
  }
}

async function stop() {
  const state = await readState();
  if (managed(state)) {
    process.kill(state.pid);
    for (let attempt = 0; attempt < 40 && alive(state.pid); attempt++) await sleep(250);
    if (alive(state.pid)) throw new Error(`The service did not stop. Check process ${state.pid}.`);
  }
  await rm(stateFile, { force: true });
  console.log("Code Workspace stopped.");
}

async function status() {
  const state = await readState();
  if (!managed(state)) { console.log("Code Workspace is not running."); process.exitCode = 1; return; }
  if (!await ready(state)) throw new Error(`The service is running but not ready. Check ${logFile}.`);
  console.log(`Code Workspace ${state.version} is running: http://127.0.0.1:${state.port}`);
}

try {
  switch (process.argv[2] || "start") {
    case "start": await start(); break;
    case "stop": await stop(); break;
    case "restart": await stop(); await start(); break;
    case "status": await status(); break;
    case "logs": console.log(existsSync(logFile) ? (await readFile(logFile, "utf8")).split(/\r?\n/).slice(-100).join("\n") : `No log file: ${logFile}`); break;
    default: throw new Error("Usage: code-workspace [start|stop|restart|status|logs]");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
