import { afterEach, expect, it, vi } from "vitest";
import { GitRunner } from "./infrastructure/git-runner.js";
import { GitService } from "./services/git-service.js";
import { WorkspaceService } from "./services/workspace-service.js";

const head = "a".repeat(40);
const header = `# branch.oid ${head}\0# branch.head main\0`;
const modified = `${header}1 MM N... 100644 100644 100644 ${head} ${head} tracked.txt\0? new.txt\0`;
const repository = { id: "repo" };
afterEach(() => vi.restoreAllMocks());

it("reads file counts without line diffs and retains full statistics for detailed status", async () => {
  const runner = new GitRunner(".");
  const run = vi.spyOn(runner, "run").mockImplementation(async args => Buffer.from(args[0] === "status" ? modified : args.includes("--cached") ? "2\t0\ttracked.txt\n" : "3\t1\ttracked.txt\n"));
  const git = new GitService(new WorkspaceService());
  const summary = await git.statusAt(repository, runner, true, false);
  expect(summary.counts).toEqual({ conflicted: 0, staged: 1, unstaged: 1, untracked: 1 });
  expect(run).toHaveBeenCalledTimes(1);
  expect(summary.files[0].additions).toBeUndefined();
  const detailed = await git.statusAt(repository, runner, false);
  expect(detailed.counts).toEqual(summary.counts);
  expect(detailed.files[0]).toMatchObject({ additions: 5, deletions: 1 });
  expect(run).toHaveBeenCalledTimes(4);
});

it("skips line diffs for clean worktrees", async () => {
  const runner = new GitRunner(".");
  const run = vi.spyOn(runner, "run").mockResolvedValue(Buffer.from(header));
  const status = await new GitService(new WorkspaceService()).statusAt(repository, runner);
  expect(status.clean).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
});

it("shares concurrent forced reads while later refreshes still read disk", async () => {
  const runner = new GitRunner(".");
  let release!: (value: Buffer) => void;
  const gate = new Promise<Buffer>(resolve => { release = resolve; });
  const run = vi.spyOn(runner, "run").mockReturnValueOnce(gate).mockResolvedValue(Buffer.from(modified));
  const git = new GitService(new WorkspaceService());
  const first = git.statusAt(repository, runner, true, false);
  const second = git.statusAt(repository, runner, true, false);
  expect(run).toHaveBeenCalledTimes(1);
  release(Buffer.from(header));
  const results = await Promise.all([first, second]);
  expect(results[0]).toBe(results[1]);
  expect((await git.statusAt(repository, runner, true, false)).files).toHaveLength(2);
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not restore an invalidated snapshot when an older read completes last", async () => {
  const runner = new GitRunner(".");
  let release!: (value: Buffer) => void;
  const gate = new Promise<Buffer>(resolve => { release = resolve; });
  const run = vi.spyOn(runner, "run").mockReturnValueOnce(gate).mockResolvedValue(Buffer.from(modified));
  const git = new GitService(new WorkspaceService());
  const stale = git.statusAt(repository, runner, true, false);
  git.invalidate(repository.id);
  const fresh = await git.statusAt(repository, runner, true, false);
  release(Buffer.from(header)); await stale;
  expect(await git.statusAt(repository, runner, false, false)).toBe(fresh);
  expect(fresh.files).toHaveLength(2);
  expect(run).toHaveBeenCalledTimes(2);
});

it("retries failed reads instead of retaining a rejected in-flight query", async () => {
  const runner = new GitRunner(".");
  vi.spyOn(runner, "run").mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(Buffer.from(header));
  const git = new GitService(new WorkspaceService());
  await expect(git.statusAt(repository, runner, true, false)).rejects.toThrow("read failed");
  expect((await git.statusAt(repository, runner, true, false)).clean).toBe(true);
});
