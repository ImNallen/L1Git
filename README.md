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

Click **+** at the top of the sidebar or press **Cmd/Ctrl+O**. Enter a path or use **Browse** to choose a directory. You can open a subfolder or symlink. L1 Git saves the canonical working-copy root and keeps linked worktrees as separate repositories. A new repository joins the end of the sidebar list. Opening a repository again keeps its place. Bare repositories return an explicit unsupported error.

L1 Git opens on your last repository and fetches every saved repository. Linked worktrees of one repository share one fetch. Click **Fetch** in the repository toolbar to fetch the open repository on demand. When some of its branches are behind their upstream and clean, the toolbar shows **Fast-forward (N)**, which moves exactly those branches. A branch checked out in a worktree with uncommitted changes, or in a worktree in the middle of a merge or rebase, is not counted. A diverged branch is never counted. In the sidebar, each repository and local branch shows how many commits it has to pull and push.

The graph shows one repository at a time, with all of its local and remote branches. The sidebar can expand any number of repositories at once, each with its own branches. Click the chevron next to a repository to show or hide its branches without changing the graph. Click a repository name to show it in the graph and expand it. The toolbar shows its name right away, and the history shows a placeholder until the first read finishes. L1 Git keeps the snapshots of the eight most recently opened repositories in memory. Returning to one of them shows its graph at once, with the commit you selected and the scroll position you left, then rereads it in the background and updates the graph if anything changed. If the selected commit is gone, the newest commit is selected. A branch you click in the sidebar takes precedence over the remembered commit. Click a branch in the sidebar to select its tip and scroll the graph to it. A branch in another repository opens that repository first. Nothing is checked out. The sidebar lists branches under **Local** and **Remote** and groups them into folders at each slash in their names, so `feat/ui/x` sits in `feat`, then `ui`. Remote branches group by remote first. Folders start closed, except the ones that hold the checked-out branch or the branch you last selected. A search opens every folder that has a match. The checked-out branch has a green background. When its folder is closed, the folder gets the green background instead. L1 Git rereads local state, including the branches of every expanded repository, whenever its window regains focus, so commits and branches you make in a terminal appear when you switch back. The open history and the branches of expanded repositories also refresh after a fetch or fast-forward moves their refs. Remote branches reflect refs already on disk, usually from your last fetch. A fetch removes remote branches that were deleted on the remote, such as a merged pull request branch. Local branches stay, and a local branch that tracked one shows that its upstream is gone.

The history contains the newest 50,000 commits reachable from local and remote branches, tags, and HEAD. If a branch tip is older than that, selecting the branch says so. Internal refs and stashes are excluded. Each row shows its branch, tag, or worktree labels to the left of the graph, then the commit message. The first label sits next to the commit's graph line and `+N` lists the rest. A worktree icon marks a branch checked out in another worktree. Each graph node shows the author's initials. Hover a node for the author's name and email. Graph connections use actual parent IDs. Dashed edges lead to parents beyond the loaded history.

Select a commit to inspect its message, author, date, parents, and changed paths. Changed paths appear as a file tree with added, modified, and deleted markers. Directories start open, and single-child directory chains collapse into one row. Select a file to replace the history with its diff against the same base. Use **Unified** or **Split** to change the layout. Click **Back to history** or press Escape to return. Selecting another commit closes the diff. Binary files and patches larger than 1 MiB show a notice instead of a diff. Merge changes are compared with the first parent. Root commits use the empty tree. Renames appear as a deletion and an addition. Parent links can open details outside the loaded history. Partial clones report a read error when required objects are missing locally. L1 Git never fetches them implicitly.

The repository list, the last active repository, and which repositories are expanded survive reloads and restarts in versioned local storage. Right-click a repository and choose **Remove** to remove it, or focus it and press Shift+F10. This removes only the saved entry. It never deletes repository files.

Click **Settings** at the bottom of the sidebar to open **Appearance**. Under **Color scheme**, choose **System**, **Light**, or **Dark**. System follows your operating system appearance. Each preview shows the scheme in the themes you picked. Under **Themes**, pick one theme for light mode and one for dark: click a light or dark orb to pick that variant, or click a theme's name to pick both. L1 is the default, and Grove, Ocean, Ember, Iris, and Rose are built in. Picking a light theme while the scheme is pinned to Dark switches the scheme to Light, and the reverse. Click **Create theme** to open a floating panel: name the theme, choose Light or Dark, and set a background and an accent. L1 Git derives the other colors. The graph lanes keep L1's colors in L1's order and start from the lane color nearest the theme's accent, so neighbouring lanes stay distinct for colorblind users in every theme. Status colors stay green, red, and amber, and their lightness, backgrounds, and the shadows follow the theme. Under every theme but L1, a diff colors added and deleted lines with those status colors and highlights code with syntax colors derived from the accent. **Advanced** lists every color for editing. The app shows the draft while the panel is open and returns to your saved theme when you cancel or press Escape. Each theme card has a duplicate button that opens the panel with that theme's colors. Your own themes also have a delete button. Deleting a theme sends light or dark mode back to L1 if it used that theme. Click **Add theme** to import theme files: choose or drop `.json` files, or paste theme JSON. L1 Git reads its own theme format, which L1 Data shares, and VS Code color themes, comments and trailing commas included. A VS Code theme's workbench colors map onto L1 Git's surfaces, text, accent, file status colors, and graph lanes, and its TextMate token colors onto the diff's syntax colors. As in VS Code, the last rule that names a scope wins. A single file that uses `include` is rejected, because the theme it includes is not in the file. Import that theme's extension from Open VSX instead. The same dialog searches the Themes category of [Open VSX](https://open-vsx.org), with **Dracula**, **Catppuccin**, **Nord**, and **Tokyo Night** as one-click searches. Picking a result downloads the extension, follows its manifest and `include` chains, and adds one theme card with every variant it contributes, light and dark. Cards with three or four variants shrink their orbs to keep one row. The desktop app's content security policy allows `open-vsx.org` and `openvsx.eclipsecontent.org`, where Open VSX serves the downloads. Open **Fetching** to choose how often L1 Git fetches in the background: **Off**, 5, 15, 30, or 60 minutes. The default is 15 minutes. Background fetches wait while the window is hidden and catch up when you return. L1 Git always fetches at launch and when you click **Fetch**, even when the schedule is Off. The app saves both choices on this device. Click **Back** or press Escape to return to your repository, with the selected commit and the open diff preserved.

## Run the browser preview

```sh
pnpm dev
```

Open <http://127.0.0.1:1422>. The browser uses the same Rust core through a development-only loopback bridge on port 9417. The Add dialog accepts a local absolute path. The native directory picker is available in the desktop app.

The bridge accepts JSON POST requests only from the development origin. It exposes the same reads, fetch, and fast-forward as the app, and no other Git writes. The reads are `/api/snapshot`, `/api/refs`, `/api/commit-detail`, `/api/line-stats`, and `/api/file-patch`. `/api/line-stats` counts added and deleted lines for up to 500 commits at once, so the history reads them only for the rows on screen. `/api/refs` returns only the root, name, HEAD, and branches, so the sidebar can list a repository's branches without reading its history. The bridge is not included in the native app. To run another isolated instance, choose both ports:

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

For performance checks, create a large repository:

```sh
pnpm fixture:large
```

The command prints a temporary directory with `repository` and `worktree` paths. The repository has 60,000 commits, a merge every 40 commits on `main`, and 50 annotated tags. It has 200 local branches in nested folders, such as `feat/graph/topic-001`, and 400 remote-tracking branches under `origin` and `upstream`. Each local branch tracks its `origin` branch, and some are ahead or behind. The `worktree` path is a linked worktree with one modified file and one untracked file. Author and commit dates are fixed, so every run creates the same commit IDs. The command takes a few seconds. Its remotes are display metadata only and set `skipFetchAll`, so a fetch skips them.

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

Rust owns `RepositorySnapshot`, `RepositoryRefs`, `RepositoryOverview`, exhaustive HEAD, branch, and upstream variants, and Git parsing in `crates/git-core`. Rust also decides whether each branch can fast-forward. Thin Tauri commands and the bridge call that same core. Runtime schemas in `src/domain/repository.ts` and `src/domain/overview.ts` validate every frontend IPC response. The real-bridge integration tests check that contract against deterministic repositories.

## What L1 Git changes

The Rust core runs exactly four Git commands that contact a remote or change a repository:

- `git fetch <remote>` for each remote that does not set `skipFetchAll` or `skipDefaultUpdate`. It updates only remote-tracking refs under `refs/remotes/`. Git 2.48 and later can also create `refs/remotes/<remote>/HEAD`. It follows your `fetch.prune` setting and does not write `FETCH_HEAD`.
- A dry-run `git fetch . <commit>:<branch>` that asks Git whether a branch is checked out in any worktree. It writes nothing. It runs only when some worktree has a detached HEAD, as a rebase or bisect leaves it. L1 Git does not move a branch when this check cannot answer.
- `git update-ref` to move a branch that is not checked out. The branch moves only from the commit you saw to the upstream commit you saw.
- `git merge --ff-only` inside the worktree of a checked-out branch. It runs only when that worktree has no uncommitted changes to tracked files and no merge, rebase, am, cherry-pick, revert, or bisect in progress. Git refuses it when the update would overwrite an untracked file.

L1 Git runs at most one fetch or fast-forward at a time per repository, and at most four fetches at once. It never creates merge commits, rebases, commits, pushes, resets, or checks out.

Fetch uses your SSH agent, credential helpers, and `core.sshCommand`. It ignores `GIT_SSH_COMMAND` and other `GIT_*` environment variables. L1 Git never prompts for a password, passphrase, or host key, so a remote that needs one reports an authentication failure. A fetch from one remote that takes longer than 5 minutes stops and reports a timeout. Error messages omit credentials from URLs.

GitHub owner/repository labels come only from recognized HTTPS or SSH URLs. Displayed remote URLs omit credentials. Other hosting providers are outside this slice.
