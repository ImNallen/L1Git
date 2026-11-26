<img src="public/icon.png" alt="L1 Git icon" width="128" height="128" />

# L1 Git

A desktop Git client for macOS, Linux, and Windows. Browse your repositories, review changes, and commit from one window.

## What you can do

- Explore commit history, compare commits, and follow a file's history or blame.
- Review unified or split diffs. Stage, unstage, or discard files, hunks, and individual lines.
- Commit, amend, and edit your last commit's message.
- Manage branches, tags, and stashes. Browse multiple repositories and linked worktrees.
- Try any branch locally in its own linked worktree, so you can run and test it without stashing or leaving the branch you are on. Remove the worktree from the same branch menu when you are done.
- Fetch, fast-forward branches, and push or publish the current branch.
- Pull the current branch from its upstream. When the branch has diverged, Pull (Fast-forward if possible) opens the merge review, Pull (Fast-forward only) leaves the branch as it is, and Pull (Rebase) rebases your local commits onto the upstream.
- Merge a selected local or remote branch into the current working copy after reviewing both refs, both commit IDs, and the files the merge will conflict in. Fast-forward when possible, or resolve text conflicts and finish or abort a merge commit.
- Cherry-pick or revert one commit from the history menu or the command palette, after reviewing what it will do. A clean result commits straight away, and a conflict opens the resolver with Finish and Abort. Undo removes the new commit and its file changes.
- Undo and redo local edits made through the app, including commits and discarded changes, from the notice that a commit, a discard, or another history change shows, or from the **More** menu.
- See the open and recently merged pull requests of all your saved GitHub repositories in one list. Filter, sort, and search it.
- Read a pull request: its conversation and review threads, commits, changed files, checks, reviewers, and whether it can merge. The diff comes from your own clone. Mark the files you have viewed. The marks stay on your computer, and GitHub doesn't know them.
- Try a pull request locally: check it out on `pr/<number>` in a worktree of its own without touching your branch or uncommitted changes, update it when the author pushes, find its commits in the history, and remove it again.
- Choose light or dark themes, create your own, or import themes from VS Code and Open VSX.

L1 Git does not force-push, and it does not resolve rebase conflicts. A Pull (Rebase) that hits a conflict is aborted and changes nothing. Fetch, fast-forward, push, remote setup, and merge Start, Finish, and Abort have no Undo entry. Creating and removing a worktree have no Undo entry either, and removing one drops the Undo entries made in it. The fetch and fast-forward that a pull runs have no Undo entry either. Pull (Rebase) has Undo and Redo. Merge resolution edits have Undo and Redo until you finish or abort.

## Get started

Download an installer from [GitHub Releases](https://github.com/ImNallen/L1Git/releases). Install Git 2.45 or later separately and make sure it is on your `PATH`.

Open L1 Git, click **+** at the top of the sidebar, choose **Local folder**, and open a repository. You can also press **Cmd+O** on macOS or **Ctrl+O** on Windows and Linux. Bare repositories are unsupported.

Select a branch to browse its history. Double-click a branch to check it out. Select **Uncommitted changes** to review your work, stage changes, and commit.

L1 Git fetches saved repositories at startup and every 15 minutes by default. To change the interval, open **Settings**, then **General**, and set **Background fetch** under **Fetching**. Remote operations use your existing Git credentials and SSH agent, with interactive prompts disabled.

To connect GitHub, open **Settings**, then **Hosts**, and click **Sign in to GitHub**. With your consent, L1 Git copies the [GitHub CLI](https://cli.github.com)'s sign-in into your system keychain and uses it to read pull requests and to write to them. It writes only when you click. **Disconnect** deletes that copy and leaves the GitHub CLI signed in.

To see pull requests, click **Pull requests** beside **Settings** at the bottom of the sidebar. Click a row to read that pull request. Press **Esc** to go back to the list, and again to go back to the history.

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

Open <http://127.0.0.1:1422>. The preview uses the same Rust core through a local development bridge.

To try the app with sample repositories, run `pnpm fixture` and add the printed `repository` path with **Local folder**. Use `pnpm fixture:large` for a larger test repository. These commands create temporary local repositories. `pnpm fixture:merge` creates clean and conflicting upstream merges for testing.

## Check and build

Run the full checks on macOS or Linux. For Windows checks, see the [CI workflow](.github/workflows/ci.yml).

```sh
cargo test --locked
pnpm test
pnpm build
pnpm format:check
pnpm lint
pnpm knip
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
```

`pnpm knip` fails on unused files, exports, and dependencies. To add a script that runs outside the app, add its path to `entry` in `knip.json`.

Build the desktop app with `pnpm tauri build`.

## Read more

- [L1 Git reference](docs/reference.md) covers app behavior, Git operations, undo history, development bridge details, and recovery.
- [Release guide](docs/releasing.md) covers packaging, signing, updates, and publishing releases.
