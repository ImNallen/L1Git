# Add and restore repositories

## Sub-features

Add by path, native directory picker, canonical deduplication, linked worktree identity, saved-list restore, failed Add, removal from recents, and the command palette.

## How to get to it (user POV)

Open L1 Git with a fresh profile or origin. The empty screen and toolbar both expose **Add repository**. The sidebar plus button has the same accessible name. **Cmd/Ctrl+O** opens the same dialog. **Cmd+P** on macOS or **Ctrl+P** elsewhere opens the command palette, a dialog named **Command palette** with a combobox named **Search actions, repositories, and branches**.

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
14. Focus the sidebar's **Search** field and press Cmd/Ctrl+P. Confirm that neither the palette nor a print dialog opens.

## Gotchas

The browser accepts a typed path and does not show a native picker. Verify **Browse…** and cancellation separately in Tauri. Invalid saved roots remain visible in the sidebar; selecting one shows **Try again** and the row still offers removal. Use only this run's fixtures for a missing-path or rename journey. Send palette keys without a native key code and count keydowns to confirm each press arrived once.
