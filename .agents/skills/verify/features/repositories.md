# Add and restore repositories

## Sub-features

Add by path, native directory picker, canonical deduplication, linked worktree identity, saved-list restore, failed Add, and removal from recents.

## How to get to it (user POV)

Open L1 Git with a fresh profile or origin. The empty screen and toolbar both expose **Add repository**. The sidebar plus button has the same accessible name. **Cmd/Ctrl+O** opens the same dialog.

## Driving it with T3 preview

1. Open **Add repository**. In the dialog named **Add a repository**, fill **Repository path** with the fixture's `repository` path. Submit **Add repository** inside the dialog.
2. Confirm `l1-demo` appears in the sidebar and `main` appears as checked-out HEAD in the toolbar. Hover the repository name to see its canonical path, which can be `/private/tmp/...` on macOS.
3. Create an empty `subfolder` directory in the fixture and add it, then add a symlink to the repository. Confirm there is still one entry for that canonical root.
4. Add the fixture's `detached` path. Confirm a separate `detached-worktree` entry and a detached HEAD label.
5. Reload. Confirm both entries remain and the last active repository reopens.
6. Open Add and submit a missing directory. Confirm an actionable error remains inside the dialog. Press Escape. Confirm the prior repository remains active.
7. Use **Remove detached-worktree from recents**. Confirm the entry disappears and the directory still exists on disk.
8. Repeat Add through the sidebar plus and **Cmd/Ctrl+O**. Cancel each dialog and confirm the saved list does not change.

## Gotchas

The browser accepts a typed path and does not show a native picker. Verify **Browse…** and cancellation separately in Tauri. Invalid saved roots remain visible in the sidebar; selecting one shows **Try again** and the row still offers removal. Use only this run's fixtures for a missing-path or rename journey.
