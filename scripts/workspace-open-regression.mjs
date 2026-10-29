// Read-only regression against explicitly supplied local directories.
// Run npm run build first. This uses isolated sessions without starting a server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { buildApp } from "../dist/server/server/app.js";

const args = process.argv.slice(2);
const roots = args.filter(arg => !arg.startsWith("--"));
const rounds = Number(args.find(arg => arg.startsWith("--rounds="))?.slice(9) ?? 3);
const output = args.find(arg => arg.startsWith("--output="))?.slice(9);
assert(roots.length && Number.isInteger(rounds) && rounds > 0 && rounds <= 10,
  "Usage: node scripts/workspace-open-regression.mjs PATH [PATH ...] [--rounds=3] [--output=report.json]");
const app = await buildApp({ disableAuth: true });
app.log.level = "silent";
const results = [];
const elapsed = start => Math.round(performance.now() - start);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
try {
  for (const root of roots) {
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      const call = async (url, method = "GET", payload) => {
        const response = await app.inject({ url, method, ...(payload ? { payload } : {}) });
        assert.equal(response.statusCode, 200, `${method} ${url}: ${response.statusCode}`);
        return response.json().data;
      };
      const start = performance.now();
      let info = await call("/api/workspace/open", "POST", { path: root, background: true });
      const openMs = elapsed(start);
      assert.equal(info.initialization.status, "loading", "Open waited for initialization");
      const initialTree = await call("/api/files/tree");
      const treeReadyMs = elapsed(start);
      assert(initialTree.length > 0, "Initial tree is empty");
      assert(initialTree.every(entry => entry.name !== ".git"), "Git internals exposed during loading");
      const initializationId = info.initialization.id;
      while (info.initialization.status === "loading") {
        assert(elapsed(start) < 60000, "Initialization timed out");
        await new Promise(resolve => setTimeout(resolve, 25));
        info = await call("/api/workspace?snapshot=1");
        assert.equal(info.initialization.id, initializationId, "Workspace was replaced while loading");
      }
      assert.equal(info.initialization.status, "ready", info.initialization.error);
      const initializationReadyMs = elapsed(start);
      const tree = await call("/api/files/tree");
      const statuses = await Promise.all(info.repositories.map(repository => call(`/api/git/status?repositoryId=${repository.id}`)));
      assert.equal(info.changedFileCount, statuses.reduce((sum, status) => sum + status.files.length, 0), "Workspace counts differ from detailed status");
      for (const [index, repository] of info.repositories.entries()) {
        assert.equal(repository.changedFileCount, statuses[index].files.length, "Repository count differs from detailed status");
        if (repository.workspacePath && !repository.workspacePath.includes("/")) {
          const row = tree.find(entry => entry.path === repository.workspacePath);
          assert.equal(row?.gitTrackedState, "repository", "Missing repository tree marker");
          assert.equal(row?.repositoryChangedFileCount, repository.changedFileCount, "Incorrect repository tree count");
        }
      }
      const nested = info.repositories.find(repository => repository.workspacePath)?.workspacePath;
      const expandStart = performance.now();
      const children = nested ? await call(`/api/files/tree?path=${encodeURIComponent(nested)}`) : tree;
      assert(children.every(entry => entry.name !== ".git"), "Git internals exposed in file tree");
      const expandMs = elapsed(expandStart);
      const signature = createHash("sha256").update(JSON.stringify({
        repositories: info.repositories.map(repository => [repository.id, repository.workspacePath, repository.branch, repository.head, repository.changedFileCount]),
        statuses: statuses.map(({ repositoryId, files, counts }) => ({ repositoryId, files, counts })),
        tree: tree.map(entry => [entry.path, entry.kind, entry.gitTrackedState, entry.repositoryChangedFileCount, entry.gitState, entry.descendantChanged])
      })).digest("hex");
      samples.push({ openMs, treeReadyMs, initializationReadyMs, expandMs, signature });
      await call("/api/workspace/close", "POST");
      const closed = await app.inject({ url: "/api/workspace" });
      assert.equal(closed.statusCode, 404, "Closed workspace still accessible");
      if (round === 0) results.push({ path: root, repositories: info.repositories.length, groups: info.repositoryGroups.length, worktrees: info.repositoryGroups.reduce((sum, group) => sum + group.worktrees.length, 0), changedFiles: info.changedFileCount, discovery: info.repositoryDiscovery, samples });
    }
    const result = results.at(-1);
    result.medianOpenMs = median(samples.map(sample => sample.openMs));
    result.medianTreeReadyMs = median(samples.map(sample => sample.treeReadyMs));
    result.medianInitializationReadyMs = median(samples.map(sample => sample.initializationReadyMs));
    result.medianExpandMs = median(samples.map(sample => sample.expandMs));
    result.consistentAcrossRounds = new Set(samples.map(sample => sample.signature)).size === 1;
    console.log(JSON.stringify(result));
  }
} finally { await app.close(); }
if (output) await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), rounds, checks: ["validated open before initialization", "root tree available during loading", "lightweight initialization polling", "all detailed statuses", "exact repository and file counts", "repository tree markers", "nested directory expansion", "Git internals hidden during and after initialization", "session close"], results }, null, 2) + "\n");
