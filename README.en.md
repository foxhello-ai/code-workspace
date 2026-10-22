# Code Workspace

[简体中文](README.md) | English

A lightweight local code workspace with a file tree, Monaco editor, Git status and history, Git diffs, and synchronization with external file changes.

It does not start terminals, Codex sessions, or AI services. External tools can edit workspace files independently.

## Features

- Open and close a local workspace.
- Browse a lazy-loaded file tree with Git status indicators.
- Create, rename, and delete files and folders.
- Edit text in multiple Monaco tabs.
- Save using content versions, with HTTP `409` conflict protection.
- Track external file and directory additions, changes, and deletions.
- Compare unsaved editor content against changes on disk.
- Inspect staged, unstaged, untracked, and conflicted Git files.
- Browse local and remote branches and switch branches with change protection.
- Fetch configured remotes explicitly, inspect individual results, and share duplicate fetch tasks within a common repository.
- Explore commit graphs with branches, merges, tags, refs, and Worktree HEAD markers.
- View history in fullscreen, locate the local HEAD, and compare local and remote ancestry and upstream ahead/behind counts.
- Use the same all/current Worktree/selected ref scope in graph and list views, with versioned pagination and loading progress.
- Browse Worktrees grouped by Git address and local common-dir base, with multiple remote addresses, global counts, main/current markers, state ordering, and details on demand.
- Preview Worktree cleanup conditions without removing Worktrees; protect Worktree roots from ordinary deletion or renaming.
- Compare HEAD, the index, working files, and individual commit files, including multi-file commit diffs.
- Apply UTF-8, binary file, large file, and path access protections.

## Requirements

- Node.js 22 or later.
- npm 10 or later for development and building from source.
- Git 2.39 or later; Worktree registration uses the NUL-delimited porcelain format. The current acceptance environment uses Git 2.40.0.
- Linux or macOS.

## Quick install

Install the latest GitHub Release on macOS or Linux. The installer verifies the archive, generates a random access password, and starts the service:

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | bash
```

Open `http://127.0.0.1:43110`. The archive includes compiled files and production dependencies; Node.js 22+, Git 2.39+, `curl`, `tar`, and `sha256sum` or `shasum` must be available locally. No npm install is needed to run the release.

The installer downloads the **Latest Release**, rather than a snapshot of `main`. The release workflow runs only when a pushed `v*` tag matches the version in `package.json`. Pushing to `main` does not update the installation archive.

Check the installed service:

```bash
~/.local/bin/code-workspace status
curl -fsS http://127.0.0.1:43110/health
```

The health endpoint should return `{"ok":true}`. The installer prints the generated password and saves it in `~/.config/code-workspace/config.env` with owner-only permissions.

The default installation directory is `~/.local/share/code-workspace`; the command is linked to `~/.local/bin/code-workspace`. Add `~/.local/bin` to your `PATH` to use:

```bash
code-workspace start
code-workspace status
code-workspace logs
code-workspace restart
code-workspace stop
```

Logs and the PID file are stored in `~/.local/state/code-workspace`. Rerun the install command to install the latest release. It preserves configuration and passwords, stops the managed service, and starts the selected version. Previous version directories are retained. Save your edits before upgrading, as the service restarts. For a specific release, set `CODE_WORKSPACE_VERSION`:

```bash
curl -fsSL https://raw.githubusercontent.com/foxhello-ai/code-workspace/main/scripts/install.sh | CODE_WORKSPACE_VERSION=1.1.1 bash
```

See the [installation guide, in Chinese](docs/installation.md) for configuration, upgrades, and release maintenance.

## Development

```bash
npm install
npm run dev
```

- Web development server: `http://localhost:4312`.
- API server: `http://127.0.0.1:43110`.

## Run from source

```bash
npm run build
npm start
```

Open `http://127.0.0.1:43110`.

### Keep the service running with PM2

```bash
npm run build
npm run pm2:start
npx pm2 save
```

Common commands:

```bash
npm run pm2:restart
npm run pm2:stop
npm run pm2:logs
npx pm2 status
```

The configuration in `ecosystem.config.cjs` restarts the service after unexpected exits and binds it to `0.0.0.0:43110`. This differs from the installer's loopback-only default.

## Git and Worktree updates

### Complete history and local/remote comparisons

1. Open **Git history** and choose **Sync remotes** to retrieve new branches and commits from configured remotes. A normal refresh only rereads local data.
2. Select **All / Current Worktree / Selected ref** in graph or list mode, and load more commits as needed. Changing the displayed scope does not check out a branch.
3. Enter fullscreen to expand the history view. Press `Esc` or use the exit button to return; the scope, loaded commits, and selection are preserved.
4. Use the highlighted **local HEAD**, local/remote ancestry labels, and upstream ahead/behind counts to compare histories. Select a commit to inspect its files and open individual or all file diffs.

Remote comparisons use fetched local refs. Missing upstreams, shallow history, and query failures retain explicit unknown states. Fetch results are held in memory and reset when the server restarts.

### Worktrees grouped by Git address

- Global counters show all Worktrees and modified, clean, and unknown counts. Filtering does not change the global totals.
- The hierarchy is **Git remote address → local base (common-dir) → Worktree**. Remote addresses and base paths are visible directly. Independent clones with the same address retain separate bases and main workspaces; linked Worktrees appear under their own base.
- The first `origin` fetch URL is preferred. Additional fetch/push addresses can be expanded. URL credentials are hidden; missing remotes and address lookup failures have separate messages.
- Address groups and bases with modifications appear first. Within a base, rows are ordered **modified → clean → unknown**. Compact rows show the branch, file state, and unpublished commit count; details open when a row is selected.
- **Main workspace** and **Current** markers are separate. Details can locate a commit, show independent changes, or open a read-only cleanup preview.

A clean working directory and published commits are separate states. Actual Worktree removal is planned for a later phase. Different SSH/HTTPS forms are not automatically treated as the same remote.

Screenshots: [fullscreen history](docs/evidence/2026-10-22-git-ui/history-fullscreen.jpg) and [Git address groups](docs/evidence/2026-10-22-git-address/address-groups.jpg).

## Verification

```bash
npm run check
```

This runs type checking, automated tests, and the production build.

Verify installation, reinstallation, the running version after an upgrade, checksum rejection, and authentication/Git APIs from the production archive:

```bash
npm run package:release
CODE_WORKSPACE_TEST_ARCHIVE="release/code-workspace-$(node -p 'require("./package.json").version').tar.gz" node --test scripts/install.test.mjs
```

The Release workflow runs the same checks before publishing the installation archive.

## Configuration

| Environment variable | Default | Description |
|---|---:|---|
| `HOST` | `127.0.0.1` | Server bind address. |
| `PORT` | `43110` | Server port. |
| `FILE_WARN_BYTES` | `2097152` | Large file warning threshold. |
| `FILE_READONLY_BYTES` | `10485760` | Read-only file threshold. |
| `GIT_TIMEOUT_MS` | `10000` | Git query timeout. |
| `GIT_FETCH_TIMEOUT_MS` | `60000` | Timeout per remote fetch command; authentication is non-interactive. |
| `GIT_WORKTREE_LIMIT` | `200` | Maximum registered entries read per common repository; partial results are marked. |
| `GIT_STATUS_LIMIT` | `40` | Maximum Worktree statuses queried per overview, with concurrency 4; others remain unknown. |
| `GIT_MAX_OUTPUT_BYTES` | `52428800` | Maximum Git command output. |
| `GIT_DISCOVERY_DEPTH` | `1` | Repository discovery depth: `0` checks only the root, `1` checks one level, and `2` checks two. |
| `GIT_DISCOVERY_MAX_DIRS` | `200` | Maximum directories checked during discovery. |
| `GIT_DISCOVERY_TIMEOUT_MS` | `5000` | Total repository discovery timeout. |
| `WATCH_DEBOUNCE_MS` | `250` | Git status refresh debounce. |
| `WATCH_MAX_FILES` | `5000` | File watcher limit; live watching is disabled above the limit to preserve Git queries. |
| `APP_PASSWORD` | `fmzh2026` | Source-run access password; override via the environment or an untracked `.env`. The installer generates a random password. |

## Security boundaries

- The default server and installer bind to loopback.
- File APIs accept paths relative to the current workspace and block access to `.git` internals.
- Symlink targets are displayed as files or directories; API access still begins with workspace-relative paths.
- Git commands do not use a shell, and clients cannot supply arbitrary Git arguments.
- Explicit fetch and protected branch switching are supported; stage, commit, discard, push, and pull are not provided by the application.
- Fetch retrieves configured remotes' heads and tags without modifying persistent refspecs or deleting local branches or tags.
- Registered Worktrees outside the workspace are displayed read-only, without extending file or branch operation permissions.
- Exposing the service beyond loopback requires separate TLS, network access control, and strong credentials.

## Current scope and design notes

- One active workspace per browser session.
- Text editing primarily supports UTF-8. Files larger than the default 10 MiB limit are not loaded into Monaco.
- Merge commits are compared against their first parent.
- Terminals, Codex sessions, AI services, and actual Worktree removal are outside the current implementation.

B-009/B-010 phase A and the P13/P14 interface updates are implemented. Requirements, plans, and acceptance evidence are maintained in the [Git change request](docs/change-request-subworkspace-git.md), [development plan](docs/subworkspace-git-development-plan.md), and [acceptance report, sections 8–10](docs/acceptance-report.md), in Chinese. Additional design and task records are in [detailed design](docs/detailed-design.md), [task plan](docs/task-plan.md), and [backlog](docs/backlog.md).

Git metadata watching covers selected refs, Worktree registrations, HEAD, and index files. More than 5,000 initial metadata entries disables automatic metadata watching with an explicit notice. Other Worktrees' source files are not watched recursively. Cleanup preview occupancy uses browser heartbeats every 15 seconds, valid for 45 seconds; it cannot detect external programs.

Create an isolated browser acceptance fixture with:

```bash
node scripts/create-git-acceptance-fixture.mjs
```

It creates temporary local bare remotes, clones, a linked Worktree, and more than 200 commits, then prints the workspace path to open.
