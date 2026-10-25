# Stage, unstage, and undo

## Sub-features

Row menus that stage, unstage, or mark a conflict resolved, **Stage all** and **Unstage all** list buttons, a diff that follows its file to the other list, toolbar **Undo** and **Redo**, Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z, the undo notice, and the stale-view and blocked-undo notices.

## How to get to it (user POV)

Add the fixture's `sync.dirty` path, the `sync-develop` worktree. Select its **Uncommitted changes** row. The inspector lists `README.md` under **Unstaged** with a **Stage all** button beside the heading. **Undo** and **Redo** sit in the repository toolbar to the left of **Fetch**.

## Driving it with T3 preview

Before and after each step, record `git -C <worktree> status --porcelain` and `git -C <worktree> ls-files -s` for every worktree you touch. Use a fresh `L1GIT_UNDO_DIR` per run, because the undo history survives restarts.

1. Hover `README.md` under **Unstaged** and click its **Options** button, or right-click the row. Choose **Stage**. Confirm the file moves to **Staged** with an **Unstage all** button and `status --porcelain` turns ` M README.md` into `M  README.md`.
2. Focus the **Staged** row and press Shift+F10. Confirm the same menu with **Unstage**. Press Enter. Confirm the file moves back and focus lands on its row under **Unstaged**.
3. Open `README.md`'s **Unstaged** diff, then stage it from its menu. Confirm the diff stays open with the **Staged** tag and the same hunk.
4. Hover **Undo** and confirm the tooltip names the entry, such as `Undo Stage README.md (⌘Z)`. Click it. Confirm the notice reads `Undid Stage README.md` with a **Redo** button, and the file is back under **Unstaged**. Press Cmd+Shift+Z with the history focused and confirm `Redid Stage README.md` with an **Undo** button. Run `ls-files -s` after each step and compare with the step before the write.
5. In a clone of the fixture's `repository`, edit two files and create an untracked one. Click **Stage all**. Confirm **Unstaged** empties and **Staged** lists three paths. Undo and confirm the notice reads `Undid Stage 3 files`.
6. Focus **Filter repositories and refs** and press Cmd+Z. Open the palette and press Cmd+Z in its field. Confirm no notice and no Git change.
7. With the worktree row shown, run `git add README.md && echo more >> README.md` in a terminal without focusing the app, then click **Stage all**. Confirm an error notice that starts `Could not stage README.md.`, `README.md` under both lists, and no change beyond the terminal's.
8. Stage a file, then run `git commit -m outside` in a terminal and click **Undo**. Confirm the notice says HEAD moved and that older changes stay blocked until this one can be undone, and that nothing changed. Run `git reset --soft HEAD~1` and click **Undo** again to confirm it works.
9. Make a merge conflict in a clone, choose **Mark resolved** on the conflicted path, then **Undo**. Confirm `UU` becomes `M ` and undo brings back the three stages in `ls-files -s`.
10. Open the palette. Confirm **Stage all** shows only with unstaged files, **Unstage all** only with staged files, and **Undo** and **Redo** only with an entry, titled with its label.
11. Stage a file, restart `pnpm dev`, and reload. Confirm **Undo** still names the stage.

## Gotchas

The row's **Options** button lives in the tree's shadow root and appears on hover or keyboard focus, so locate it inside `file-tree-container` or right-click the row instead. Staging stages what is on disk, so a file edited after L1 Git read it answers the stale-view notice rather than staging the new bytes. One undo history covers every worktree of a repository. Undo works in order, so an entry that cannot be undone blocks the older ones until it can. `@pierre/trees` row decorations cannot hold a button, so the row's write lives in its menu.
