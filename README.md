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

Right-click the history's column headers, or press Shift+F10 or the context menu key while the history has focus, to choose which columns follow the commit message. **Author** shows the author's name. **Date** shows when the commit was authored, as a relative time such as `3 days ago`. Hover a date for the full date and time. **SHA** shows the shortest commit ID prefix, at least seven characters, that no other loaded commit shares, and widens to fit the longest one. Hover it for the full ID. **Changes** shows how many lines each commit added and deleted, and is the only one on at first. Hiding **Changes** stops L1 Git from counting lines. Turning on Author, Date, or SHA narrows the commit message's minimum width so more columns fit. When the menu closes, the history scrolls sideways to show the last column you turned on if it is out of view. Press Up and Down to move through the menu, Home and End to jump to the first and last item, Space or Enter to toggle a column, and Escape to close it. The app saves your columns on this device, and every repository uses the same ones.

Select a commit to inspect its message, author, date, parents, and changed paths. Changed paths appear as a file tree with added, modified, and deleted markers. Directories start open, and single-child directory chains collapse into one row. Select a file to replace the history with its diff against the same base. Use **Unified** or **Split** to change the layout. Click **Back to history** or press Escape to return. Selecting another commit closes the diff. Binary files and patches larger than 1 MiB show a notice instead of a diff. Merge changes are compared with the first parent. Root commits use the empty tree. Renames appear as a deletion and an addition. Parent links can open details outside the loaded history. Partial clones report a read error when required objects are missing locally. L1 Git never fetches them implicitly.

Click a commit or Tab to the history to move through it with the keyboard. The history is one Tab stop. While it has focus, the selected row takes an accent tint, and it returns to the plain selection color when focus moves elsewhere. Press Down or J to select the next commit and Up or K to select the previous one. Press Home, Cmd/Ctrl+Home, or Cmd/Ctrl+Up to select the newest loaded commit, and End, Cmd/Ctrl+End, or Cmd/Ctrl+Down to select the oldest. On macOS, Ctrl+Up and Ctrl+Down are Mission Control shortcuts by default, so use Cmd. Press Shift+Down or Shift+J to follow the selected commit's first parent, so a move from a merge skips the branch it merged. Press Shift+Up or Shift+K to go back the way Shift+Down came. After you select a commit any other way, Shift+Up selects a newer commit whose first parent is the selected commit. When several qualify, it picks the one whose graph line runs into the selected commit, or else the nearest one. The history scrolls only as far as it must to show the selected row, and the inspector follows the selection. Press Enter to open the first changed file in the inspector's tree, and focus moves to **Back to history**. If the inspector is still reading the commit, the file opens when the read finishes. Pressing Escape, moving the selection, or leaving the history first cancels it. When the diff closes, focus returns to the history with the same commit selected, unless it is in the sidebar or a dialog. The keys work only while the history has focus, so typing in a search field or a dialog never moves the selection.

Press Cmd+F on macOS, or Ctrl+F on other systems, to search the loaded history. A field opens above the history. It matches commits whose subject, author name, or email contains what you type, and commits whose ID starts with it. Matching ignores case and treats composed and decomposed accents alike, as the sidebar filter does. Matching rows stay lit, and the other rows and the graph lines fade. The selected row keeps its full selection color. The field reads `n of m` while the selected commit is a match, however you selected it, and the number of matches otherwise. Press Enter or Shift+Enter in the field, or click the arrow buttons beside it, to select the next or previous match after the selected commit, in history order. The history scrolls to each match. Press Escape in the field, or click the close button, to close the search. The selected commit stays selected and focus returns to the history. Opening the search closes the column menu, and opening another repository closes the search. Search reads only the loaded commits and their subjects, not full commit messages. While a file diff is open, the shortcut does nothing in L1 Git, so click **Back to history** first.

The repository list, the last active repository, and which repositories are expanded survive reloads and restarts in versioned local storage. Right-click a repository and choose **Remove** to remove it, or focus it and press Shift+F10. This removes only the saved entry. It never deletes repository files.

Click **Settings** at the bottom of the sidebar to open **Appearance**. Under **Color scheme**, choose **System**, **Light**, or **Dark**. System follows your operating system appearance. Each preview shows the scheme in the themes you picked. Under **Themes**, pick one theme for light mode and one for dark: click a light or dark orb to pick that variant, or click a theme's name to pick both. L1 is the default, and Grove, Ocean, Ember, Iris, and Rose are built in. Picking a light theme while the scheme is pinned to Dark switches the scheme to Light, and the reverse. Click **Create theme** to open a floating panel: name the theme, choose Light or Dark, and set a background and an accent. L1 Git derives the other colors. The graph lanes keep L1's colors in L1's order and start from the lane color nearest the theme's accent, so neighbouring lanes stay distinct for colorblind users in every theme. Status colors stay green, red, and amber, and their lightness, backgrounds, and the shadows follow the theme. Under every theme but L1, a diff colors added and deleted lines with those status colors and highlights code with syntax colors derived from the accent. **Advanced** lists every color for editing. The app shows the draft while the panel is open and returns to your saved theme when you cancel or press Escape. Each theme card has a duplicate button that opens the panel with that theme's colors. Your own themes also have a delete button. Deleting a theme sends light or dark mode back to L1 if it used that theme. Click **Add theme** to import theme files: choose or drop `.json` files, or paste theme JSON. L1 Git reads its own theme format, which L1 Data shares, and VS Code color themes, comments and trailing commas included. A VS Code theme's workbench colors map onto L1 Git's surfaces, text, accent, file status colors, and graph lanes, and its TextMate token colors onto the diff's syntax colors. As in VS Code, the last rule that names a scope wins. A single file that uses `include` is rejected, because the theme it includes is not in the file. Import that theme's extension from Open VSX instead. The same dialog searches the Themes category of [Open VSX](https://open-vsx.org), with **Dracula**, **Catppuccin**, **Nord**, and **Tokyo Night** as one-click searches. Picking a result downloads the extension, follows its manifest and `include` chains, and adds one theme card with every variant it contributes, light and dark. Cards with three or four variants shrink their orbs to keep one row. The desktop app's content security policy allows `open-vsx.org` and `openvsx.eclipsecontent.org`, where Open VSX serves the downloads. Open **Fetching** to choose how often L1 Git fetches in the background: **Off**, 5, 15, 30, or 60 minutes. The default is 15 minutes. Background fetches wait while the window is hidden and catch up when you return. L1 Git always fetches at launch and when you click **Fetch**, even when the schedule is Off. The app saves both choices on this device. Click **Back** or press Escape to return to your repository, with the selected commit and the open diff preserved.

## Run the browser preview

```sh
pnpm dev
```

Open <http://127.0.0.1:1422>. The browser uses the same Rust core through a development-only loopback bridge on port 9417. The Add dialog accepts a local absolute path. The native directory picker is available in the desktop app.

The bridge accepts JSON POST requests only from the development origin, on one route, `/api/run`. Each request names its operation in an `op` field. A successful answer is `{"op": ..., "data": ...}` with the same `op`, and the bridge adds `"ok": true` to it. A repository error comes back as `{"ok": false, "error": ...}`. The bridge rejects an unknown operation, a missing field, or an unknown field with status 400 and a message that names the problem. It exposes the same reads, fetch, and fast-forward as the app, and no other Git writes. The reads are `snapshot`, `refs`, `commitDetail`, `lineStats`, `filePatch`, `worktreeStatus`, and `worktreePatch`. `overview` reads branch status and can fetch first. `fastForward` moves branches. `lineStats` counts added and deleted lines for up to 500 commits at once, so the history reads them only for the rows on screen. `refs` returns only the root, name, HEAD, and branches, so the sidebar can list a repository's branches without reading its history. The bridge is not included in the native app. To run another isolated instance, choose both ports:

```sh
L1GIT_DEV_PORT=1423 L1GIT_BRIDGE_PORT=9418 pnpm dev
```

Every read has a deadline. When the deadline passes, L1 Git stops Git and every process Git started, such as a clean filter, and the read returns a `timedOut` error that names the read and asks you to retry. The inspector shows it with **Retry details**. A history read that times out shows it with **Try again**, above the last history it read or in place of a history it never read. Each deadline is about 100 times or more the read's run time on the `pnpm fixture:large` repository:

| Read | Deadline |
| --- | --- |
| `snapshot` | 120 s |
| `refs`, `lineStats`, `worktreeStatus`, `worktreePatch` | 30 s |
| `commitDetail`, `filePatch` | 20 s |
| Branch status in `overview` and `fastForward` | 60 s |

A deadline covers all of a read's Git commands. Branch status is the exception. Its deadline starts again after each fetch, checkout probe, branch move, or fast-forward merge, because those commands have their own deadlines, and after waiting for another fetch or fast-forward of the same repository to finish.

A read waits for Git's error output only when it reports a failure, and then for at most 1 s after Git exits, so a filter that leaves a background process running cannot hold a read open. Each Git command runs in its own process group, so Ctrl-C or closing the terminal does not reach it directly. The native app and the development bridge stop every Git command still running when they quit, including on Ctrl-C, SIGTERM, SIGHUP, or SIGQUIT. They wait up to 1 s for a Git command that is starting to be listed, and refuse to start new ones. Quitting can take about 2 s when a Git command is slow to start and another ignores SIGTERM. A force quit or SIGKILL skips this step. To try a short deadline, start the bridge with `L1GIT_READ_DEADLINE_MS`, which lowers each read deadline to at most that many milliseconds. It does not change fetch or fast-forward deadlines.

`worktreeStatus` lists one worktree's changed paths. These are staged and unstaged edits, renames and copies, conflicts, submodules, and untracked files. `worktreePatch` takes a `file` from that list and a `side`. `staged` diffs HEAD, or the empty tree before the first commit, against the index. `unstaged` diffs the index against the working tree, and covers untracked files. A conflicted path returns its conflict and its diff against HEAD. That diff is absent for a submodule, for a file gone from the working tree, and for a file that matches HEAD. A staged submodule change returns its gitlink diff, and an unstaged one returns the submodule's state instead of a diff. An untracked file's patch is Git's own diff of the file against nothing, so it shows what `git add` would stage, after `.gitattributes`, line-ending settings, and clean filters such as Git LFS. On macOS and Linux, L1 Git first reads the file without following symbolic links, then checks that Git's blob ID and shown text match those bytes. If they differ, the read fails and asks you to refresh. Other systems cannot read untracked file patches. A file larger than 1 MiB on disk returns its file size instead of a diff, and Git output larger than 1 MiB returns the patch size. If a required filter fails, the read returns Git's error. A file replaced by a named pipe during the read makes the read time out instead of waiting forever. Paths inside a `.git` directory are refused. L1 Git runs no Git command that writes for either read. A clean filter, such as Git LFS, can still store objects, as it would for `git diff`.

An untracked file's patch differs from `git add -N` followed by `git diff` in these cases:

- Git reads `.gitattributes` from the working tree. A `.gitattributes` file deleted from the working tree but still in the index is ignored.
- A clean filter whose output changes between runs always fails with the refresh message.
- A top-level file named `-` reaches Git as `./-`, so a filter that uses `%f` sees `./-`.
- The size check runs first, so a required filter that fails on a file over 1 MiB returns the size instead of the error.
- External diff drivers and `diff.mnemonicPrefix` do not apply, as for every other diff in L1 Git.

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

The command prints a temporary directory with `repository` and `worktree` paths. The repository has 60,000 commits and 50 annotated tags. Every 40th commit on the first-parent line of `main` is a merge. It has `main` and 199 local branches in nested folders, such as `feat/graph/topic-001`. It has 400 remote-tracking branches under `origin` and `upstream`, plus `origin/HEAD`. Each local branch tracks its `origin` branch, and some are ahead or behind. The tip of `archive/old-tip` is older than the newest 50,000 commits, so the history does not load it. More than 500 commits edit `src/hot/history.ts`, and its 400 lines were last changed by 400 different commits. The `worktree` path is a linked worktree with one modified file and one untracked file. Author and commit dates are fixed, and the command ignores your global and system Git config, so every run creates the same commit IDs. The command takes a few seconds. Its remotes are display metadata only and set `skipFetchAll`, so a fetch skips them.

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

Rust owns `RepositorySnapshot`, `RepositoryRefs`, `RepositoryOverview`, exhaustive HEAD, branch, and upstream variants, and Git parsing in `crates/git-core`. Rust also decides whether each branch can fast-forward. The Tauri command `repository_run` and the bridge route `/api/run` call that same core through one `run` function. Runtime schemas in `src/domain/repository.ts` and `src/domain/overview.ts` validate every frontend IPC response. The real-bridge integration tests check that contract against deterministic repositories.

## What L1 Git changes

The Rust core runs exactly four Git commands that contact a remote or change a repository:

- `git fetch <remote>` for each remote that does not set `skipFetchAll` or `skipDefaultUpdate`. It updates only remote-tracking refs under `refs/remotes/`. Git 2.48 and later can also create `refs/remotes/<remote>/HEAD`. It follows your `fetch.prune` setting and does not write `FETCH_HEAD`.
- A dry-run `git fetch . <commit>:<branch>` that asks Git whether a branch is checked out in any worktree. It writes nothing. It runs only when some worktree has a detached HEAD, as a rebase or bisect leaves it. L1 Git does not move a branch when this check cannot answer.
- `git update-ref` to move a branch that is not checked out. The branch moves only from the commit you saw to the upstream commit you saw.
- `git merge --ff-only` inside the worktree of a checked-out branch. It runs only when that worktree has no uncommitted changes to tracked files and no merge, rebase, am, cherry-pick, revert, or bisect in progress. Git refuses it when the update would overwrite an untracked file.

L1 Git runs at most one fetch or fast-forward at a time per repository, and at most four fetches at once. It never creates merge commits, rebases, commits, pushes, resets, or checks out.

Fetch uses your SSH agent, credential helpers, and `core.sshCommand`. It ignores `GIT_SSH_COMMAND` and other `GIT_*` environment variables. L1 Git never prompts for a password, passphrase, or host key, so a remote that needs one reports an authentication failure. A fetch from one remote that takes longer than 5 minutes stops and reports a timeout. The local reads before and after a fetch use the branch status deadline. Error messages omit credentials from URLs.

GitHub owner/repository labels come only from recognized HTTPS or SSH URLs. Displayed remote URLs omit credentials. Other hosting providers are outside this slice.
