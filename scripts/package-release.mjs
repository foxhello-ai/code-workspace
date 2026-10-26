import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const releaseDir = path.join(root, "release");
const stagingDir = path.join(releaseDir, "staging");
const packageDir = path.join(stagingDir, "code-workspace");
const suffix = process.platform === "win32" ? `-windows-${process.arch}.zip` : ".tar.gz";
const archiveName = `code-workspace-${version}${suffix}`;
const archivePath = path.join(releaseDir, archiveName);
const checksumPath = `${archivePath}.sha256`;
const lockfile = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

if (!existsSync(path.join(root, "dist", "server", "server", "index.js"))) {
  throw new Error("未找到生产构建产物。请先执行 npm run build。");
}

rmSync(stagingDir, { recursive: true, force: true });
rmSync(archivePath, { force: true });
rmSync(checksumPath, { force: true });
mkdirSync(packageDir, { recursive: true });

for (const source of ["dist", "bin", "package.json", "package-lock.json", "README.md", "README.en.md"]) {
  cpSync(path.join(root, source), path.join(packageDir, source), { recursive: true });
}

const sourceModules = path.join(root, "node_modules");
if (!existsSync(path.join(sourceModules, "fastify"))) {
  throw new Error("未找到生产依赖。请先执行 npm ci。");
}
// Copy production packages directly. Copying the complete development tree and
// then deleting it makes Windows release builds spend minutes on unused files.
const productionPackages = Object.entries(lockfile.packages)
  .filter(([relativePath, metadata]) => relativePath.startsWith("node_modules/") && metadata.dev !== true)
  .map(([relativePath]) => relativePath)
  .sort((left, right) => left.length - right.length);
console.log("Staging production dependencies...");
for (const relativePath of productionPackages) {
  const source = path.join(root, relativePath);
  if (!existsSync(source)) continue; // Optional dependencies for other platforms.
  const target = path.join(packageDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: candidate => candidate !== path.join(source, "node_modules") });
}
rmSync(path.join(packageDir, "node_modules", ".bin"), { recursive: true, force: true });
rmSync(path.join(packageDir, "node_modules", ".package-lock.json"), { force: true });

const archiveTempDir = mkdtempSync(path.join(tmpdir(), "code-workspace-release-"));
const archiveTempPath = path.join(archiveTempDir, archiveName);
try {
  console.log("Creating release archive...");
  const archiveCommand = process.platform === "win32" ? "powershell.exe" : "tar";
  const archiveArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CODE_WORKSPACE_PACKAGE_DIR, $env:CODE_WORKSPACE_ARCHIVE_PATH, [IO.Compression.CompressionLevel]::Optimal, $true)"]
    : ["-czf", archiveTempPath, "-C", stagingDir, "code-workspace"];
  const archiveEnv = { ...process.env, LC_ALL: "C", LANG: "C", CODE_WORKSPACE_PACKAGE_DIR: packageDir, CODE_WORKSPACE_ARCHIVE_PATH: archiveTempPath };
  if (process.platform === "win32") for (const key of Object.keys(archiveEnv)) if (key.toLowerCase() === "psmodulepath") delete archiveEnv[key];
  execFileSync(archiveCommand, archiveArgs, {
    cwd: root,
    stdio: "inherit",
    env: archiveEnv
  });
  copyFileSync(archiveTempPath, archivePath);
} finally {
  rmSync(archiveTempDir, { recursive: true, force: true });
}

const checksum = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
writeFileSync(checksumPath, `${checksum}  ${archiveName}\n`);
const aliasName = `code-workspace-latest${suffix}`;
copyFileSync(archivePath, path.join(releaseDir, aliasName));
writeFileSync(path.join(releaseDir, `${aliasName}.sha256`), `${checksum}  ${aliasName}\n`);

console.log(`已生成发布包：${path.relative(root, archivePath)}`);
console.log(`SHA-256：${checksum}`);
