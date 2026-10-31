<img src="public/icon.png" alt="L1 Git icon" width="128" height="128" />

# L1 Git

A desktop Git client for macOS, Linux, and Windows. Browse your repositories, review changes, and commit from one window.

## What you can do

- Explore commit history, compare commits, and follow a file's history or blame.
- Review unified or split diffs. Stage, unstage, or discard files, hunks, and individual lines.
- Commit, amend, and edit your last commit's message.
- Manage branches, tags, and stashes. Browse multiple repositories and linked worktrees.
- Fetch, fast-forward branches, and push or publish the current branch.
- Merge a diverged branch with its reviewed upstream, resolve text conflicts, and finish or abort.
- Undo and redo local edits made through the app, including commits and discarded changes.
- Choose light or dark themes, create your own, or import themes from VS Code and Open VSX.

L1 Git does not rebase or force-push. Fetch, fast-forward, push, remote setup, and merge Start, Finish, and Abort have no Undo entry. Merge resolution edits have Undo and Redo until you finish or abort.

## Get started

Download an installer from [GitHub Releases](https://github.com/ImNallen/L1Git/releases). Install Git 2.45 or later separately and make sure it is on your `PATH`.

Open L1 Git, click **+** in the sidebar, and choose a local repository. You can also press **Cmd+O** on macOS or **Ctrl+O** on Windows and Linux. Bare repositories are unsupported.

Select a branch to browse its history. Double-click a branch to check it out. Select **Uncommitted changes** to review your work, stage changes, and commit.

L1 Git fetches saved repositories at startup and every 15 minutes by default. Change the interval in **Settings > Fetching**. Remote operations use your existing Git credentials and SSH agent, with interactive prompts disabled.

Press **Cmd+P** on macOS or **Ctrl+P** elsewhere to open the command palette.

## Develop locally

L1 Git uses Tauri 2, React, TypeScript, and a shared Rust Git core.

Install these tools:

- Git 2.45 or later.
- Node.js 26 and pnpm 10.32.1.
- Rust 1.93 or later.
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. On macOS, install Xcode and its command-line tools.

From the repository root, install dependencies and start the desktop app:

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

If macOS selects the standalone command-line tools instead of Xcode, run:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri dev
```

To run in a browser instead:

```sh
pnpm dev
```

Open <http://127.0.0.1:1422>. The preview uses the same Rust core through a local development bridge. Enter an absolute repository path in the Add dialog.

To try the app with sample repositories, run `pnpm fixture` and open the printed `repository` path. Use `pnpm fixture:large` for a larger test repository. These commands create temporary local repositories. `pnpm fixture:merge` creates clean and conflicting upstream merges for testing.

## Check and build

Run the full checks on macOS or Linux. For Windows checks, see the [CI workflow](.github/workflows/ci.yml).

```sh
cargo test --locked
pnpm test
pnpm build
pnpm format:check
pnpm lint
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
```

Build the desktop app with `pnpm tauri build`.

## Read more

- [L1 Git reference](docs/reference.md) covers app behavior, Git operations, undo history, development bridge details, and recovery.
- [Release guide](docs/releasing.md) covers packaging, signing, updates, and publishing releases.
