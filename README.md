# L1 Git

L1 Git is a desktop Git client in the L1 family, built with Tauri 2, React, and TypeScript. This slice browses real local repositories. It reads branches, commit history, and commit details. Its Rust core can also fetch remotes and fast-forward local branches that are strictly behind their upstream. It never merges, rebases, commits, pushes, or moves a checked-out branch whose tracked files have uncommitted changes.

## Run the desktop app

Install Git 2.45 or later, Node.js 26, pnpm 10.32.1, Rust 1.93 or later, and the native Tauri build dependencies. On macOS, install Xcode and its command-line tools.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

If macOS selects the standalone command-line tools instead of Xcode, start with:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri dev
```

Click **Add repository** or press **Cmd/Ctrl+O**. Enter a path or use **Browse** to choose a directory. You can open a subfolder or symlink. L1 Git saves the canonical working-copy root and keeps linked worktrees as separate repositories. Bare repositories return an explicit unsupported error.

Click a local or remote branch to browse its history. The checked-out HEAD remains in the top toolbar. **Refresh** rereads local state. Remote branches reflect refs already on disk, usually from your last fetch.

The history contains at most 200 commits for local and remote branches plus HEAD, or for the selected branch. Internal refs and stashes are excluded. Search covers the loaded subjects, authors, emails, and commit IDs. Graph connections use actual parent IDs. Connections are hidden during search because filtered rows omit intermediate commits. Dashed edges lead to parents beyond the loaded history.

Select a commit to inspect its message, author, date, parents, and changed paths. Changed paths appear as a file tree with added, modified, and deleted markers. Directories start open, and single-child directory chains collapse into one row. Select a file to replace the history with its diff against the same base. Use **Unified** or **Split** to change the layout. Click **Back to history** or press Escape to return. Selecting another commit closes the diff. Binary files and patches larger than 1 MiB show a notice instead of a diff. Merge changes are compared with the first parent. Root commits use the empty tree. Renames appear as a deletion and an addition. Parent links can open details outside the loaded history. Partial clones report a read error when required objects are missing locally. L1 Git never fetches them implicitly.

The repository list and last active repository survive reloads and restarts in versioned local storage. Remove a repository with the row's **Remove from recents** button. This removes only the saved entry. It never deletes repository files.

Click **Settings** at the bottom of the sidebar to open **Appearance**. Choose **System**, **Light**, or **Dark**. System follows your operating system appearance. The app saves your choice on this device. Click **Back** or press Escape to return to your repository with its filters, selected commit, and open diff preserved.

## Run the browser preview

```sh
pnpm dev
```

Open <http://127.0.0.1:1422>. The browser uses the same Rust core through a development-only loopback bridge on port 9417. The Add dialog accepts a local absolute path. The native directory picker is available in the desktop app.

The bridge accepts JSON POST requests only from the development origin. It exposes the same reads, fetch, and fast-forward as the app, and no other Git writes. It is not included in the native app. To run another isolated instance, choose both ports:

```sh
L1GIT_DEV_PORT=1423 L1GIT_BRIDGE_PORT=9418 pnpm dev
```

Recents belong to each browser origin or the native WebView. The native app and browser preview have separate saved lists.

## Create local sample repositories

```sh
pnpm fixture
```

The command prints a temporary fixture directory and working-copy paths. Add the printed `repository` path to the app. It has two local branches, three remote branches, a merge commit, a commit with nested, modified, deleted, and binary paths, and GitHub metadata. Its `detached` and `unborn` paths cover those HEAD states. Its `remote` path is a local bare repository for the unsupported-path journey.

The `sync` paths are a second repository for fetch and fast-forward. After a fetch, `main` in `sync.repository` is one commit behind and ready to fast-forward. `develop` is behind but checked out in `sync.dirty` with an uncommitted edit. `feat/diverged` has diverged from its upstream. A `sync.colleague` clone made those remote commits.

Fixture creation pushes and fetches only against its temporary local bare repositories. It never writes to GitHub. The configured GitHub remotes are display metadata only. Each sets `remote.github.skipFetchAll`, so a fetch skips it.

## Check and build

```sh
cargo test --locked
pnpm test
pnpm build
pnpm format:check
cargo fmt --all --check
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri build --debug
```

The default Rust workspace members are the lightweight core and bridge. `pnpm test` builds the bridge, checks its real HTTP responses against the frontend schemas, and tests graph lanes and saved repositories. The macOS command builds an app in `target/debug/bundle/macos/L1 Git.app`.

Rust owns `RepositorySnapshot`, `RepositoryOverview`, exhaustive HEAD, branch, and upstream variants, and Git parsing in `crates/git-core`. Rust also decides whether each branch can fast-forward. Thin Tauri commands and the bridge call that same core. Runtime schemas in `src/domain/repository.ts` and `src/domain/overview.ts` validate every frontend IPC response. The real-bridge integration tests check that contract against deterministic repositories.

## What L1 Git changes

The app does not show fetch or fast-forward controls yet. The Rust core runs exactly four Git commands that contact a remote or change a repository:

- `git fetch <remote>` for each remote that does not set `skipFetchAll` or `skipDefaultUpdate`. It updates only remote-tracking refs under `refs/remotes/`. Git 2.48 and later can also create `refs/remotes/<remote>/HEAD`. It follows your `fetch.prune` setting and does not write `FETCH_HEAD`.
- A dry-run `git fetch . <commit>:<branch>` that asks Git whether a branch is checked out in any worktree. It writes nothing. It runs only when some worktree has a detached HEAD, as a rebase or bisect leaves it. L1 Git does not move a branch when this check cannot answer.
- `git update-ref` to move a branch that is not checked out. The branch moves only from the commit you saw to the upstream commit you saw.
- `git merge --ff-only` inside the worktree of a checked-out branch. It runs only when that worktree has no uncommitted changes to tracked files and no merge, rebase, am, cherry-pick, revert, or bisect in progress. Git refuses it when the update would overwrite an untracked file.

L1 Git runs at most one fetch or fast-forward at a time per repository, and at most four fetches at once. It never creates merge commits, rebases, commits, pushes, resets, or checks out.

Fetch uses your SSH agent, credential helpers, and `core.sshCommand`. It ignores `GIT_SSH_COMMAND` and other `GIT_*` environment variables. L1 Git never prompts for a password, passphrase, or host key, so a remote that needs one reports an authentication failure. A fetch from one remote that takes longer than 5 minutes stops and reports a timeout. Error messages omit credentials from URLs.

GitHub owner/repository labels come only from recognized HTTPS or SSH URLs. Displayed remote URLs omit credentials. Other hosting providers are outside this slice.
