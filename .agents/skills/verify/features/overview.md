# Update behind branches

## Sub-features

Launch Overview, launch fetch, Fetch in the Overview header and the repository toolbar, one-click Fast-forward, Update all, blocked and diverged rows, last fast-forward outcomes, per-remote fetch failures, sidebar badges, the Fetching schedule in Settings, and history refresh after refs move.

## How to get to it (user POV)

Save at least one repository and reload. L1 Git opens on **Overview** and fetches every saved repository. The sidebar item **Overview** returns to it from any repository. **Settings** at the bottom of the sidebar has a **Fetching** section.

## Driving it with T3 preview

Use the fixture's `sync` paths. Before the journey, record `for-each-ref refs/heads refs/remotes`, `symbolic-ref HEAD`, and `status --porcelain` for `sync.repository`, `sync.dirty`, and `repository`.

1. Add `sync.dirty`, then `sync.repository`, then `repository`. Reload. Confirm the page opens on **Overview** with the header status **Fetching…**, then **Fetched just now**. One `sync-demo` card shows `· +1 worktree`. No second card appears for `sync-develop`.
2. In the `sync-demo` card, confirm `main` with **default** says `Behind origin/main by 1 commit` and `Checked out in sync-demo`, and has **Fast-forward main**. Confirm `develop` with **mainline** says `Uncommitted changes in sync-develop. Commit or stash first.` and has no button. Confirm `feat/diverged` says `Diverged. L1 Git never merges or rebases.` and has no button. **Update all (1)** and the sidebar badge on **Overview** both count 1. The `sync-demo` and `sync-develop` sidebar rows each show a behind count of 2.
3. Confirm the `repository` card shows `main` up to date and no failure note. Its `github` remote sets `skipFetchAll`, so the fetch never contacts GitHub. To see a per-remote failure, run `git -C <repository> remote add archive /nonexistent/archive.git` and click **Fetch** in the Overview header. Confirm the card shows a failure note for `archive` while `sync-demo` stays usable. Run `git -C <repository> remote remove archive` afterwards.
4. Click **Fast-forward main**. Confirm the row says `Up to date with origin/main` and `Fast-forwarded to <short id>.`, and **Update all** is disabled. With Git, confirm `main` in `sync.repository` moved to `origin/main`, the new commit has one parent, `status --porcelain` is empty, and `develop` and `feat/diverged` did not move.
5. Click **Open sync-demo**. Confirm the history shows the `main` label on the colleague commit without clicking **Refresh**.
6. In `sync.repository`, run `git branch --track release origin/main`. In `sync.colleague`, switch to `main`, commit, and push. Click **Fetch** in the Overview header. Confirm **Update all (2)** and ready rows for `main` and `release`. Click **Update all**. Confirm both rows report `Fast-forwarded to <short id>.` and Git shows both at the new `origin/main`. `develop` stays blocked and unmoved, and `sync.dirty` still lists ` M README.md`.
7. In `sync.colleague`, switch to `develop`, commit, and push. Open `sync-demo` and click **Fetch** in the repository toolbar. Confirm the new commit appears under `origin/develop` in the history and Git shows only `refs/remotes/origin/develop` moved.
8. Open **Settings**, then **Fetching**. Confirm the breadcrumb reads `Settings / Fetching` and the choices are Off, 5 min, 15 min, 30 min, and 60 min with 15 min selected. Choose 5 min and reload. Confirm 5 min is still selected and `l1git.fetch.v1` holds `{"version":1,"intervalMinutes":5}`. Click **Back** and confirm it returns to the screen you came from.
9. Repeat steps 2 and 4 in Light and Dark. Confirm cards, role tags, warning notes, success notes, badges, and the selected Settings item stay legible.

After the journey, record the same Git state. Only `main`, `release`, and remote-tracking refs may differ. Git 2.48 or later can also create `refs/remotes/origin/HEAD` during the first fetch.

## Gotchas

Adding a repository also fetches it, so reload or push a new remote commit before checking the launch fetch. A branch that is fast-forwarded and is not default or mainline moves into the `N more branches up to date` line. Store behavior that a live drive cannot reach quickly, such as coalesced requests and the hidden-window interval, is covered in `src/overview.test.ts`.
