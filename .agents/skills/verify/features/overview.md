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

## Push the current branch

Use a new browser tab at a private development origin and the fixture's private `sync` remote. Follow the active host's browser-driver restrictions. Never clear user recents. API tests and a bundle build do not prove this rendered journey.

1. Record the complete bare remote ref map with `git -C <sync.remote> for-each-ref --format='%(refname) %(objectname)'`. Record HEAD, `status --porcelain`, `ls-files -s`, file bytes, and the app's Undo history for each saved worktree.
2. Open `sync.repository` on `main` after fast-forwarding it. Create one local commit through the commit inspector. Confirm the sidebar shows one outgoing commit. The toolbar and command palette both say **Push to origin/main**. The toolbar title names the source branch, destination, and redacted endpoint. Record local state and Undo history again before Push.
3. Click **Push to origin/main**. Confirm a spinner while it runs, then a pushed notice and zero outgoing commits without clicking Fetch. Compare the complete remote ref map. Only `refs/heads/main` may move, to the exact local commit recorded before the click. HEAD, the index, files, and Undo history stay unchanged by Push. Push again and confirm an already-up-to-date notice.
4. Save `sync.dirty` before `sync.repository` in the private session. Open `sync.repository` and confirm the target remains its `main` upstream. Open `sync.dirty` and confirm the target is its `develop` upstream. Push the latter only if you intend to publish that fixture branch, and verify that no other remote ref moves.
5. Create another local commit on `main`. Install a temporary rejecting `pre-receive` hook only in the fixture's bare remote. Click Push and confirm a visible **Push rejected** notice. The complete remote ref map stays unchanged. Remove that fixture hook and retry to confirm ordinary success.
6. Once the toolbar shows its prepared target, change `branch.main.merge` externally to `refs/heads/alternate` without refreshing. Click the displayed Push control. Confirm a changed-destination notice, no remote ref movement, and a newly prepared **Push to origin/alternate** target. Restore the fixture's original merge setting and refresh.
7. Create and check out a fixture branch without an upstream. Refresh the app. Confirm the toolbar and palette offer **Publish branch…** and follow the publication journey below. Detached and unborn fixture repositories still show disabled Push controls with their specific reasons.
8. Repeat the destination, successful notice, disabled reason, and palette checks in Light and Dark. Save screenshots and the before/after Git state outside the repository.

An uncertain notice must never promise that nothing was published. The automated core tests cover a timeout after remote acceptance, capped porcelain, and a confirmed push followed by refresh failure. A live drive is still required for the toolbar, palette, notices, and outgoing badge.

## Publish a branch without tracking

Use private fixture repositories in both browser and native sessions. The implementation tests do not replace this live journey.

1. Create and check out a fixture branch without tracking, for example `git switch -c publish-review`. Record its full OID, complete bare remote ref map, effective `branch.publish-review.remote` and `branch.publish-review.merge`, HEAD, index entries, file bytes, and Undo history.
2. Refresh and click **Publish branch…** in the toolbar. Confirm a labelled modal traps focus and Escape closes it without changing refs or config. Open it from the palette. Confirm the destination defaults to `publish-review` and one eligible remote is selected automatically. With two eligible fixture remotes, confirm an explicit choice is required. With no remotes, confirm the actionable empty state and disabled review button.
3. Choose the fixture remote and destination `reviewed-publication`. Click **Review publication**. Confirm the review shows `refs/heads/publish-review`, the exact full OID recorded in step 1, the remote name, `refs/heads/reviewed-publication`, and the effective push endpoint with credentials removed. Confirm the final button says **Publish branch**. No publication happens during preparation.
4. Edit the destination to an invalid ref. Confirm the review disappears immediately, the button returns to **Review publication**, and submitting shows an error. Enter a valid destination and review it again. Change the remote while preparation is pending and confirm an older result cannot restore the previous review.
5. Click **Publish branch**. Confirm a published notice with **Upstream set** and a refreshed ordinary **Push to <remote>/reviewed-publication** control. Verify only the reviewed bare remote branch changed, to the reviewed OID. Verify both effective tracking keys together. HEAD, the index, files, and Undo history remain unchanged. Ordinary Push now reports already up to date.
6. On another untracked fixture branch, review publication, then make a local commit or change the selected remote's push URL externally. Confirm publication refuses the stale review and no remote ref or tracking key changes. Reopen and review the current state.
7. Install a temporary rejecting receive hook in the private bare remote. Confirm rejection changes neither remote refs nor tracking keys. Remove it. Hold the fixture common config's `config.lock`, then publish. Confirm the remote branch is published while the notice reports upstream setup failure. Verify both keys remain absent and the held lock is unchanged. Remove only the lock you created.
8. Repeat the review, edit, confirm, and notice checks in Light and Dark. Save screenshots and before/after Git evidence outside the repository. Never publish to the fixture's display-only GitHub remote.

Core tests also prove that symbolic fetch targets and hook-created symbolic refs cannot move unrelated local branches. Concurrent tracking-ref updates survive publication and produce a separate refresh notice. Core tests also cover post-hook checkout, commit, and config changes, timeout after acceptance, staged-config failure, custom and negative fetch mappings, unrelated includes and worktree config, and publication surviving tracking or refresh failure.

## Gotchas

Adding a repository also fetches it, so reload or push a new remote commit before checking the launch fetch. **Fast-forward (N)** counts only the open repository and is disabled while that repository fetches or fast-forwards. Store behavior that a live drive cannot reach quickly, such as coalesced requests, per-repository scoping, and the hidden-window interval, is covered in `src/overview.test.ts`.
