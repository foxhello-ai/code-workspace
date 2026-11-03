import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = data => createHash("sha256").update(data).digest("hex");
const stateRoot = root => `${root}.releases`;
const json = async file => JSON.parse(await readFile(file, "utf8"));
const exists = async file => realpath(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

function assetPath(root, relative) {
  if (!relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(relative)) throw new Error(`Invalid asset path: ${relative}`);
  return path.join(root, ...relative.split("/"));
}

async function filesIn(root, relative = "") {
  const result = [];
  for (const entry of await readdir(assetPath(root, relative || "assets"), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const name = `${relative || "assets"}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not static assets: ${name}`);
    if (entry.isDirectory()) result.push(...await filesIn(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

// Check directory entries too: macOS/Windows may otherwise hide case errors.
async function readExact(root, relative) {
  let directory = root;
  const parts = relative.split("/");
  assetPath(root, relative);
  for (const part of parts) {
    const names = await readdir(directory);
    if (!names.includes(part)) throw new Error(`Missing asset or filename case mismatch: ${relative}`);
    directory = path.join(directory, part);
  }
  return readFile(directory);
}

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, data, { flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function snapshot(root, requireManifest = false) {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const files = [];
  for (const name of await filesIn(root)) {
    const data = await readExact(root, name);
    files.push({ path: name, size: data.length, sha256: digest(data) });
  }
  const names = new Set(files.map(file => file.path));
  const references = [...html.matchAll(/(?:src|href)=["']\/?(assets\/[^"'?#]+)(?:[?#][^"']*)?["']/g)].map(match => match[1]);
  if (requireManifest) {
    if (!await exists(path.join(root, ".vite/manifest.json"))) throw new Error("Build has no Vite manifest; refusing to publish.");
    const manifest = await json(path.join(root, ".vite/manifest.json"));
    for (const chunk of Object.values(manifest)) {
      references.push(chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? []));
      for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) if (!manifest[dependency]) throw new Error(`Missing manifest dependency: ${dependency}`);
    }
  }
  if (!references.length) throw new Error("Build has no entry assets; refusing to publish.");
  for (const reference of references) if (!names.has(reference)) throw new Error(`Missing asset or filename case mismatch: ${reference}`);
  const id = digest(JSON.stringify({ html, files })).slice(0, 20);
  return { id, createdAt: new Date().toISOString(), html, files };
}

async function history(root) {
  if (!await exists(path.join(root, "index.html"))) return [];
  const current = await snapshot(root);
  const saved = await json(path.join(stateRoot(root), "history.json")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  // A saved snapshot lists just its build, whereas the serving directory is a union.
  const active = saved.find(release => release.html === current.html);
  if (active) {
    await verify(root, active);
    return [active, ...saved.filter(release => release.id !== active.id)];
  }
  return [current, ...saved.filter(release => release.id !== current.id)];
}

async function verify(root, release) {
  for (const file of release.files) {
    const data = await readExact(root, file.path);
    if (data.length !== file.size || digest(data) !== file.sha256) throw new Error(`Incomplete or changed asset: ${file.path}`);
  }
}

async function mergeAssets(source, destination, releases) {
  // Preflight every collision before writing any new assets or switching HTML.
  const pending = [];
  const seen = new Set();
  for (const release of releases) for (const file of release.files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const data = await readExact(source, file.path);
    if (data.length !== file.size || digest(data) !== file.sha256) throw new Error(`Incomplete or changed asset: ${file.path}`);
    const target = assetPath(destination, file.path);
    if (await exists(target)) {
      const existing = await readExact(destination, file.path);
      if (digest(existing) !== file.sha256) throw new Error(`Immutable asset collision: ${file.path}`);
    } else pending.push({ target, data });
  }
  for (const { target, data } of pending) await atomicWrite(target, data);
}

function keep(releases) {
  const seen = new Set();
  return releases.filter(release => !seen.has(release.id) && seen.add(release.id)).slice(0, 3);
}

async function saveAndActivate(root, releases) {
  for (const release of releases) await verify(root, release);
  // Metadata can safely precede activation: history() derives the active version
  // from the HTML if publication is interrupted. Cleanup only follows activation.
  await atomicWrite(path.join(stateRoot(root), "history.json"), JSON.stringify(releases, null, 2) + "\n");
  await atomicWrite(path.join(root, "index.html"), releases[0].html);
  const retained = new Set(releases.flatMap(release => release.files.map(file => file.path)));
  for (const name of await filesIn(root)) if (!retained.has(name)) await rm(assetPath(root, name));
}

async function locked(root, action) {
  const directory = stateRoot(root);
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, "publish.lock");
  try { await mkdir(lock); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another static publication is running; inspect ${lock} before retrying.`); throw error; }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function publishWebRelease(source, destination, { verifyAssets } = {}) {
  return locked(destination, async () => {
    const next = await snapshot(source, true);
    const releases = keep([next, ...await history(destination)]);
    await mergeAssets(source, destination, [next]);
    if (verifyAssets) await verifyAssets(next);
    await saveAndActivate(destination, releases);
    return next.id;
  });
}

export async function inheritWebReleases(previous, destination) {
  if (!await exists(path.join(destination, "index.html"))) throw new Error("Release has no index.html.");
  if (!await exists(path.join(previous, "index.html")) || await realpath(previous) === await realpath(destination)) return;
  return locked(destination, async () => {
    const current = (await history(destination))[0];
    const older = (await history(previous)).filter(release => release.id !== current.id).slice(0, 2);
    await mergeAssets(previous, destination, older);
    await saveAndActivate(destination, keep([current, ...older]));
  });
}

export async function rollbackWebRelease(root, id) {
  return locked(root, async () => {
    const releases = await history(root);
    const selected = releases.find(release => release.id === id);
    if (!selected) throw new Error(`Release is outside the retained versions: ${id}`);
    await saveAndActivate(root, [selected, ...releases.filter(release => release.id !== id)]);
    return id;
  });
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second] = process.argv.slice(2);
    if (command === "inherit" && first && second) await inheritWebReleases(path.resolve(first), path.resolve(second));
    else if (command === "rollback" && first && second) console.log(await rollbackWebRelease(path.resolve(first), second));
    else if (command === "list" && first) console.log(JSON.stringify((await history(path.resolve(first))).map(({ id, createdAt }) => ({ id, createdAt })), null, 2));
    else throw new Error("Usage: web-release.mjs inherit <previous-web-root> <next-web-root> | list <web-root> | rollback <web-root> <release-id>");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
