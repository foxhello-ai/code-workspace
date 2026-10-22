// Disposable local fixture for B-009/B-010 browser acceptance. Never uses a production remote.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "cw-git-browser-")));
const root = path.join(base, "workspace"), main = path.join(root, "main"), linked = path.join(root, "worktree-feature"), producer = path.join(base, "producer"), remote = path.join(base, "remote.git");
await mkdir(root);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const configure = cwd => { git(cwd, "config", "user.name", "Acceptance"); git(cwd, "config", "user.email", "test@example.com"); };
git(base, "init", "--bare", "-q", "--initial-branch=trunk", remote);
git(base, "clone", "-q", remote, main); configure(main);
await writeFile(path.join(main, "a.txt"), "root a\n"); await writeFile(path.join(main, "b.txt"), "root b\n"); await writeFile(path.join(main, ".gitignore"), "ignored/\n");
git(main, "add", "."); git(main, "commit", "-qm", "root commit"); git(main, "push", "-qu", "origin", "trunk"); git(main, "remote", "set-head", "origin", "-a");
const initial = git(main, "rev-parse", "HEAD"); let input = "";
for (let i = 1; i <= 225; i++) { const subject = `pagination commit ${i}`; input += `commit refs/heads/codex/long\nmark :${i}\ncommitter Acceptance <test@example.com> ${1600000000 + i} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\nfrom ${i === 1 ? initial : `:${i - 1}`}\n\n`; }
execFileSync("git", ["fast-import", "--quiet"], { cwd: main, input });
git(main, "worktree", "add", "-qb", "feat/local", linked);
await writeFile(path.join(linked, "a.txt"), "unpublished feature a\n"); await writeFile(path.join(linked, "b.txt"), "unpublished feature b\n"); git(linked, "add", "."); git(linked, "commit", "-qm", "local feature changes two files");
await writeFile(path.join(main, "a.txt"), "unstaged main edit\n");
git(base, "clone", "-q", remote, producer); configure(producer); git(producer, "switch", "-qc", "feat/remote");
await writeFile(path.join(producer, "a.txt"), "remote feature a\n"); await writeFile(path.join(producer, "b.txt"), "remote feature b\n"); git(producer, "add", "."); git(producer, "commit", "-qm", "remote feature changes two files"); git(producer, "tag", "release/v1"); git(producer, "push", "-q", "origin", "feat/remote", "--tags");
console.log(JSON.stringify({ base, root, main, linked, producer, remote }, null, 2));
