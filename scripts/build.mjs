import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishWebRelease } from "../bin/web-release.mjs";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "dist"), { recursive: true });
const staging = await mkdtemp(path.join(root, "dist/.build-"));

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}): ${script}`)));
  });
}

try {
  await run("node_modules/typescript/bin/tsc", ["-p", "tsconfig.server.json", "--outDir", path.join(staging, "server")]);
  await run("node_modules/vite/bin/vite.js", ["build", "--outDir", path.join(staging, "web")]);
  // A failed compile/bundle never touches the serving directory. The running
  // server keeps its loaded modules; the next restart uses the compiled server.
  await cp(path.join(staging, "server"), path.join(root, "dist/server"), { recursive: true });
  const origin = process.env.CODE_WORKSPACE_VERIFY_ORIGIN;
  const verifyAssets = origin ? async release => {
    const files = release.files.filter(file => !/\.(br|gz)$/.test(file.path));
    for (let offset = 0; offset < files.length; offset += 4) await Promise.all(files.slice(offset, offset + 4).map(async file => {
      const response = await fetch(new URL(`/${file.path}`, origin), { headers: { "accept-encoding": "identity" }, signal: AbortSignal.timeout(15_000) });
      const data = Buffer.from(await response.arrayBuffer());
      if (response.status !== 200 || data.length !== file.size || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new Error(`Published resource verification failed: ${file.path}`);
    }));
    console.log(`Verified ${files.length} resources through ${new URL(origin).origin} before switching HTML.`);
  } : undefined;
  const id = await publishWebRelease(path.join(staging, "web"), path.join(root, "dist/web"), { verifyAssets });
  console.log(`Published static release ${id}; current and two previous builds retained.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
