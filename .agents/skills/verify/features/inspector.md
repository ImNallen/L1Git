# Inspect a commit

## Sub-features

Full commit metadata, SHA copy, parent navigation, the changed-file tree, merge policy, and inspector resizing or hiding.

## How to get to it (user POV)

Open the fixture repository. Use **Toggle commit inspector** if the pane is hidden. Select a commit by its description button in the history table.

## Driving it with T3 preview

1. Select the description whose accessible name begins `Merge branch feat/history`. Confirm the inspector shows its full SHA, author `N Allen`, two parent links, and changed paths `graph.ts` and `history.ts`.
2. Confirm the comparison says **Compared with the first parent**. Click either parent hash. Confirm the inspector changes to that exact parent SHA.
3. Select `feat(inspector): show commit message and changed paths`. Confirm the summary `4 added · 1 deleted · 1 modified` and a tree with open `assets` and flattened `src / inspector` directories, with `icon.png`, `files/tree.ts`, and `panel.ts` beneath them. Confirm `graph.ts` has a `D` marker, `history.ts` an `M` marker, and the added paths `A` markers. Clicking a file opens its diff, covered in [Read a file diff](diff.md).
4. Select `docs: start the local Git fixture`. Confirm **Root commit**, an empty-tree comparison, and the added `README.md` path.
5. Click **Copy commit SHA**. Confirm the copied status and clipboard content when the driver has clipboard access.
6. At a width of at least 1100 pixels, confirm the inspector and its separator span the full workspace height, aligned with the left sidebar at the top and bottom. Confirm the repository toolbar sits beside the inspector. Drag **Resize commit inspector**, or focus the separator and use arrow keys. Confirm a width change. Confirm exactly one visible **Toggle commit inspector** control, in the inspector header when open and in the repository toolbar when closed. Hide and reopen the inspector with that control. Confirm keyboard focus follows the control to its new location after each toggle.
7. Open the `sync` repository and select the row named **Uncommitted changes** with the `sync-develop` badge. Confirm the inspector reads **Uncommitted changes**, names `sync-develop` with its path, links its HEAD commit with `On develop`, and lists `README.md` under **Unstaged** with an `M` marker. Click the HEAD link and confirm that commit is selected. In the fixture's `repository`, run `git add graph.ts` after an edit, create an untracked `notes.txt`, then focus the app. Confirm `graph.ts` is under **Staged** and `notes.txt` under **Unstaged** with a `U` marker. Run `git mv search.ts finder.ts` and confirm `finder.ts` appears under **Staged** with a rename marker, and that its diff says `Renamed from search.ts. The content did not change.` Undo every change with Git afterwards.
8. Resize below 1100 pixels. Confirm the inspector hides and its toolbar toggle reopens it as an overlay from the workspace top to the bottom. Confirm the resize separator is hidden. Close the overlay with **Toggle commit inspector** in its header, then reopen it with **Toggle commit inspector** in the toolbar. Confirm exactly one visible toggle and that keyboard focus follows it after each toggle. Confirm horizontal history scrolling remains usable.

## Gotchas

Changes use the first parent for every non-root commit. Renames are separate deleted and added paths in a commit, and one renamed path in a worktree. A worktree's conflicts have their own **Conflicts** list with an `M` marker, because the tree has no conflict marker. It opens with a `Conflict` tag, and its diff names the conflict, such as `Modified by both.` A conflict with no diff against HEAD says so instead of showing an empty pane. An untracked nested repository appears as one `nested` entry, not an empty folder, and opening it explains that L1 Git cannot show it. Clicking a path selects it with no focus ring. Keyboard focus in the tree shows the sidebar's cue, a 10 percent accent tint and a 2px blue bar on the left, over the inspector background or the selected row's background. The tree lives in a shadow root and virtualizes its rows, so a commit with hundreds of paths renders only the visible rows. Its rows appear as `treeitem` entries in accessibility snapshots. Parent details can be read outside the loaded history. Clipboard access can be unavailable in some browser drivers; record that limitation and verify it natively. Do not replace a failed clipboard action with an internal state setter.
