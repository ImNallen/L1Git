# L1 Git

L1 Git is a desktop Git client in the L1 family, built with Tauri 2, React, and TypeScript. This first slice browses real local repositories. It reads branches, commit history, and commit details without changing your working copy or contacting a remote.

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

The history contains at most 200 commits for all refs or the selected branch. Search covers the loaded subjects, authors, emails, and commit IDs. Graph connections use actual parent IDs. Connections are hidden during search because filtered rows omit intermediate commits. Dashed edges lead to parents beyond the loaded history.

Select a commit to inspect its message, author, date, parents, and changed paths. Merge changes are compared with the first parent. Root commits use the empty tree. Renames appear as a deletion and an addition. Parent links can open details outside the loaded history. Partial clones report a read error when required objects are missing locally. L1 Git never fetches them implicitly.

The repository list and last active repository survive reloads and restarts in versioned local storage. Remove a repository with the row's **Remove from recents** button. This removes only the saved entry. It never deletes repository files.

## Run the browser preview

```sh
pnpm dev
```

Open <http://127.0.0.1:1422>. The browser uses the same Rust reader through a development-only loopback bridge on port 9417. The Add dialog accepts a local absolute path. The native directory picker is available in the desktop app.

The bridge accepts JSON POST requests only from the development origin and exposes no Git write commands. It is not included in the native app. To run another isolated instance, choose both ports:

```sh
L1GIT_DEV_PORT=1423 L1GIT_BRIDGE_PORT=9418 pnpm dev
```

Recents belong to each browser origin or the native WebView. The native app and browser preview have separate saved lists.

## Create local sample repositories

```sh
pnpm fixture
```

The command prints a temporary fixture directory and working-copy paths. Add the printed `repository` path to the app. It has two local branches, three remote branches, a merge commit, and GitHub metadata. Its `detached` and `unborn` paths cover those HEAD states. Its `remote` path is a local bare repository for the unsupported-path journey.

Fixture creation pushes and fetches only against its temporary local bare repository. It never writes to GitHub. The configured GitHub remote is display metadata only.

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

Rust owns `RepositorySnapshot`, exhaustive HEAD and branch variants, and Git parsing in `crates/git-core`. Thin Tauri commands and the bridge call that same reader. Runtime schemas in `src/domain/repository.ts` validate every frontend IPC response. The real-bridge integration tests check that contract against deterministic repositories.

The app has no fetch, pull, push, checkout, or other Git write actions. GitHub owner/repository labels come only from recognized HTTPS or SSH URLs. Displayed remote URLs omit credentials. Authentication and other hosting providers are outside this slice.
