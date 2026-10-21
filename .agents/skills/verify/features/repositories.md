# Add and restore repositories

## Sub-features

Add by path, native directory picker, canonical deduplication, linked worktree identity, saved-list restore, failed Add, removal from recents, the command palette, and the sidebar's Tags, Stashes, and Submodules sections.

## How to get to it (user POV)

Open L1 Git with a fresh profile or origin. The empty screen and toolbar both expose **Add repository**. The sidebar plus button has the same accessible name. **Cmd/Ctrl+O** opens the same dialog. **Cmd+P** on macOS or **Ctrl+P** elsewhere opens the command palette, a dialog named **Command palette** with a combobox named **Search actions, repositories, and refs**.

## Driving it with T3 preview

1. Open **Add repository**. In the dialog named **Add a repository**, fill **Repository path** with the fixture's `repository` path. Submit **Add repository** inside the dialog.
2. Confirm `l1-demo` appears in the sidebar and `main` appears as checked-out HEAD in the toolbar. Hover the repository name to see its canonical path, which can be `/private/tmp/...` on macOS.
3. Create an empty `subfolder` directory in the fixture and add it, then add a symlink to the repository. Confirm there is still one entry for that canonical root.
4. Add the fixture's `detached` path. Confirm a separate `detached-worktree` entry and a detached HEAD label.
5. Reload. Confirm both entries remain and the last active repository reopens.
6. Open Add and submit a missing directory. Confirm an actionable error remains inside the dialog. Press Escape. Confirm the prior repository remains active.
7. Use **Remove detached-worktree from recents**. Confirm the entry disappears and the directory still exists on disk.
8. Repeat Add through the sidebar plus and **Cmd/Ctrl+O**. Cancel each dialog and confirm the saved list does not change.
9. Add the fixture's `sync.repository` path. Open the palette, type `fetch`, and press Enter. Confirm **Fetch** disables while it runs and **Fast-forward (1)** shows in the toolbar.
10. Open the palette, type `l1-demo`, and press Enter. Confirm `l1-demo` opens. Open the palette again, type a branch name such as `feat/history`, and press Enter. Confirm the graph selects that branch's tip and the sidebar highlights the branch.
11. Open the palette and press Up once. Confirm the last item is highlighted and scrolled into view, then press Down to wrap to the first. Type `zzqx` and confirm the palette says nothing matches.
12. Press Escape, then open the palette again and click outside it. Confirm both close it, run nothing, and return focus to where it was.
13. Open **Settings** from the palette and confirm **Appearance** shows. Open the palette there and confirm it lists only **Toggle sidebar**, **Open Fetching settings**, and **Back to repository**. Press Escape once to close the palette and once more to leave Settings.
14. Focus the sidebar field named **Filter repositories and branches** and press Cmd/Ctrl+P. Confirm that neither the palette nor a print dialog opens.

## Tags, stashes, and submodules

1. Expand `l1-demo`. Confirm **Tags** follows **Remote** with a count of 1 and lists `v0.1.0`. The fixture has no stashes or submodules, so neither section shows.
2. Click `v0.1.0`. Confirm the theme commit `feat(theme): add the L1 dark canvas` is selected, the history scrolls to it, and the tag row is highlighted.
3. Clone the fixture's `repository` into a scratch directory. In the clone, run `git -c protocol.file.allow=always submodule add <repository> vendor/demo`, commit, edit `README.md`, and run `git stash push -m "Try a README"`. Add the clone. Confirm **Stashes** lists `On main: Try a README` with `stash@{0}`, and **Submodules** lists `vendor/demo` with the first seven characters of `git rev-parse HEAD:vendor/demo`.
4. Click the stash. Confirm the inspector shows `On main: Try a README`, a `stash@{0}` chip, and `README.md` as modified. Select `README.md` and confirm its diff matches `git stash show -p`. Confirm no history row shows the stash.
5. Make a second stash in a terminal and switch back to the app. Confirm it appears as `stash@{0}` and the first stash becomes `stash@{1}`.
6. Type `v0.1` into **Filter repositories and branches**. Confirm only Tags rows remain and every other section says it has no match. Type `vendor` and `README` to filter submodules and stashes, then clear the filter.
7. Collapse **Tags**, **Stashes**, and **Submodules** one at a time. Confirm each toggles without the others.
8. With the clone open, click the `l1-demo` tag. Confirm `l1-demo` opens with the theme commit selected. With `l1-demo` open, click the clone's stash and confirm the clone opens with the stash selected.
9. In the clone, run `git tag side origin/feat/squashed`, switch back, and solo `origin/feat/history`. Click `side`. Confirm the notice `side is outside the soloed branches.` and a **Show all branches** button that clears the rule and selects the tag's commit.
10. On the large fixture, expand **Tags**. Confirm 50 tags in version order, `v1.9.0` before `v1.10.0`.

## Gotchas

A stash saved with `--include-untracked` shows only its tracked changes. A gitlink with no `.gitmodules` entry is not listed as a submodule.

The browser accepts a typed path and does not show a native picker. Verify **Browse…** and cancellation separately in Tauri. Invalid saved roots remain visible in the sidebar; selecting one shows **Try again** and the row still offers removal. Use only this run's fixtures for a missing-path or rename journey. Send palette keys without a native key code and count keydowns to confirm each press arrived once.
