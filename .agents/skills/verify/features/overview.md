# Update behind branches

## Sub-features

Launch fetch, Fetch and **Fast-forward (N)** in the repository toolbar, per-branch sync counts in the sidebar, fetch and fast-forward warnings above the history, the Fetching schedule in Settings, and history refresh after refs move.

## How to get to it (user POV)

Save at least one repository and reload. L1 Git opens on the repository screen and fetches every saved repository. The repository toolbar has **Fetch** and, when the open repository has branches that are behind and clean, **Fast-forward (N)**. **Settings** at the bottom of the sidebar has a **Fetching** section.

## Driving it with T3 preview

Use the fixture's `sync` paths. Before the journey, record `for-each-ref refs/heads refs/remotes`, `symbolic-ref HEAD`, and `status --porcelain` for `sync.repository`, `sync.dirty`, and `repository`.

1. Add `sync.dirty`, then `sync.repository`, then `repository`. Reload. Confirm the page opens on the repository screen and the toolbar **Fetch** button shows a spinner while the launch fetch runs.
2. Open `sync-demo`. Confirm the toolbar shows **Fast-forward (1)**. Its title says it fast-forwards 1 branch that is behind and clean and never merges or rebases. The `sync-demo` and `sync-develop` sidebar rows each show a behind count of 2. `develop` is blocked by uncommitted changes in `sync-develop` and `feat/diverged` has diverged, so neither counts.
3. Open `repository`. Confirm no **Fast-forward** button appears and no warning notice shows. Its `github` remote sets `skipFetchAll`, so the fetch never contacts GitHub. To see a per-remote failure, run `git -C <repository> remote add archive /nonexistent/archive.git` and click **Fetch**. Confirm an alert starting `archive: Fetch failed.` appears above the history. Run `git -C <repository> remote remove archive`, click **Fetch** again, and confirm the alert clears.
4. Open `sync-demo` and click **Fast-forward (1)**. Confirm the button disappears and the history shows the `main` label on the colleague commit without clicking **Refresh**. With Git, confirm `main` in `sync.repository` moved to `origin/main`, the new commit has one parent, `status --porcelain` is empty, and `develop` and `feat/diverged` did not move.
5. In `sync.repository`, run `git branch --track release origin/main`. In `sync.colleague`, switch to `main`, commit, and push. Click **Fetch** in the repository toolbar. Confirm **Fast-forward (2)**. Click it. Confirm Git shows `main` and `release` at the new `origin/main`. `develop` stays blocked and unmoved, and `sync.dirty` still lists ` M README.md`.
6. In `sync.colleague`, switch to `develop`, commit, and push. Click **Fetch** in the repository toolbar. Confirm the new commit appears under `origin/develop` in the history and Git shows only `refs/remotes/origin/develop` moved.
7. Open **Settings**, then **Fetching**. Confirm the breadcrumb reads `Settings / Fetching` and the choices are Off, 5 min, 15 min, 30 min, and 60 min with 15 min selected. Choose 5 min and reload. Confirm 5 min is still selected and `l1git.fetch.v1` holds `{"version":1,"intervalMinutes":5}`. Click **Back** and confirm it returns to the repository screen.
8. Repeat steps 2 and 4 in Light and Dark. Confirm the toolbar buttons, sidebar sync counts, and the selected Settings item stay legible.

After the journey, record the same Git state. Only `main`, `release`, and remote-tracking refs may differ. Git 2.48 or later can also create `refs/remotes/origin/HEAD` during the first fetch.

## Gotchas

Adding a repository also fetches it, so reload or push a new remote commit before checking the launch fetch. **Fast-forward (N)** counts only the open repository and is disabled while that repository fetches or fast-forwards. Store behavior that a live drive cannot reach quickly, such as coalesced requests, per-repository scoping, and the hidden-window interval, is covered in `src/overview.test.ts`.
