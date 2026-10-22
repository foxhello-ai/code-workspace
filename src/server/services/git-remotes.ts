import path from "node:path";
import type { GitRemoteAddresses } from "../../shared/contracts.js";
import { config } from "../config.js";
import { GitRunner } from "../infrastructure/git-runner.js";

// Only display transport locations: credentials, query strings and fragments never reach the client.
function displayAddress(raw: string, root: string) {
  const value = raw.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      return url.toString();
    } catch { return null; }
  }
  // SCP-like SSH addresses retain the conventional git user, but never an arbitrary credential user.
  if (/^[a-z][a-z\d+.-]*::/i.test(value)) return null;
  const scp = value.match(/^(?:([^/@:]+)@)?(\[[^\]]+\]|[^/\s:]+):(.+)$/);
  if (scp) return `${scp[1] === "git" ? "git@" : ""}${scp[2]}:${scp[3].split(/[?#]/)[0]}`;
  if (value.startsWith("/") || value.startsWith(".") || !value.includes(":")) return path.resolve(root, value);
  return null;
}

export async function readGitRemoteAddresses(root: string): Promise<GitRemoteAddresses> {
  const result: GitRemoteAddresses = { primaryName: null, primaryUrl: null, remotes: [] };
  const runner = new GitRunner(root, Date.now() + config.gitTimeoutMs);
  try {
    // NUL-delimited config preserves spaces and all URLs; do not parse the human-oriented remote -v table.
    const raw = await runner.text(["config", "--null", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], { allowFailure: true });
    if (!raw) {
      // get-regexp exits 1 for no matches. A successful key-only query distinguishes this from config failure.
      await runner.run(["config", "--null", "--list", "--name-only"]);
      return result;
    }
    const remotes = new Map<string, GitRemoteAddresses["remotes"][number]>();
    for (const entry of raw.split("\0").filter(Boolean)) {
      const delimiter = entry.indexOf("\n");
      if (delimiter < 0) continue;
      const key = entry.slice(0, delimiter), value = entry.slice(delimiter + 1);
      const match = key.match(/^remote\.(.+)\.(url|pushurl)$/i);
      if (!match || !value.trim()) continue;
      const remote = remotes.get(match[1]) ?? { name: match[1], fetchUrls: [], pushUrls: [] };
      const target = match[2].toLowerCase() === "url" ? remote.fetchUrls : remote.pushUrls;
      const address = displayAddress(value, root);
      if (!address) result.error = "部分 Git 地址格式无法识别";
      else if (!target.includes(address)) target.push(address);
      remotes.set(remote.name, remote);
    }
    result.remotes = [...remotes.values()].sort((a, b) => Number(b.name === "origin") - Number(a.name === "origin") || a.name.localeCompare(b.name));
    for (const remote of result.remotes) if (!remote.pushUrls.length) remote.pushUrls = [...remote.fetchUrls];
    const primary = result.remotes.find(remote => remote.fetchUrls.length);
    result.primaryName = primary?.name ?? null;
    result.primaryUrl = primary?.fetchUrls[0] ?? null;
  } catch { result.error = "Git 地址读取失败，请刷新重试"; }
  return result;
}
