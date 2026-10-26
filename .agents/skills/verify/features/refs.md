# Create, rename, and delete branches

## Sub-features

**New branch…** in a commit's menu in the history and in a sidebar branch's menu, **Rename…** and **Delete…** in a local branch's menu, the name dialog with Git's reason under the field, the delete confirmation that says what the branch is not merged into, **New branch from <name>…**, **Rename <name>…**, and **Delete <name>…** in the palette for the sidebar branch last selected, and undo and redo of each write.

## How to get to it (user POV)

Add the fixture's `repository` path. Right-click the `feat(theme): add the L1 dark canvas` commit, which carries the `v0.1.0` tag, for **New branch…**. Right-click a branch under **Local** or **Remote** in the sidebar, or focus it and press Shift+F10, for the branch items below **Hide** and **Solo**.

## Driving it with T3 preview

Before and after each step, record `git -C <worktree> for-each-ref`, `git -C <worktree> symbolic-ref -q HEAD`, and `git -C <worktree> config --local --get-regexp '^branch\.'` for every worktree you touch. Use a fresh `L1GIT_UNDO_DIR` per run, because the undo history survives restarts.

1. Right-click the theme commit and choose **New branch…**. Confirm the dialog says the branch starts at that commit and focus is in **Branch name**. Type `topic` and press Enter. Confirm `topic` appears under **Local**, its label sits on the theme commit, the commit is selected, and the only change is a new `refs/heads/topic` at that commit.
2. Open **New branch…** again and try `bad..name`, `-x`, `feat/`, and `main`. Confirm each shows Git's reason under the field, such as `'bad..name' is not a valid branch name.` and `A branch named 'main' already exists.`, the dialog stays open, no error notice appears above the history, and nothing changes.
3. Right-click `main` in the sidebar. Confirm **Delete…** is dimmed with `Checked out in l1-demo`. Focus `topic`, press Shift+F10, move to **Rename…**, and press Enter. Confirm the field holds `topic` with all of it selected. Type `work/topic` and press Enter. Confirm the branch moves into a `work` folder, which opens, at the same tip.
4. Run `git -C <repository> branch --set-upstream-to=origin/feat/history feat/squashed`. Choose **Delete…** on `feat/squashed`. Confirm **Cancel** has focus and the dialog reads `feat/squashed is not merged into HEAD (main) or its upstream origin/feat/history.` Click **Delete branch**. Confirm the ref and its `branch.feat/squashed.*` settings are gone and focus moves to the history.
5. Make a branch with three commits only it reaches and an upstream, delete it from its menu, then run `git reflog expire --expire=now --all && git gc --prune=now` and confirm `git cat-file -e <tip>` fails. Click **Undo**. Confirm `git log` reaches all three commits, `git fsck --connectivity-only` passes, the upstream settings are back, and the recordings match the ones before the delete.
6. Create a branch from a remote branch, which sets its upstream, then rename it. Click **Undo** twice and **Redo** twice, running the `reflog expire` and `gc` above before each click. Confirm each undo leaves the recordings identical to the ones before its write and each redo identical to the ones after it.
7. Open the delete dialog on `topic`, run `git branch -f topic HEAD~1` in a terminal, then confirm. Confirm the notice reads `Could not delete branch topic. topic is no longer at the commit L1 Git showed, so nothing changed. Refresh and try again.` and the only change is the terminal's.
8. Add the fixture's `sync.repository`. Open the menu of `develop`, which `sync.dirty` has checked out, and confirm **Delete…** is dimmed with `Checked out in sync-develop`. POST its `deleteBranch` to the bridge and confirm it answers `conflict` and nothing changes.
9. In `sync.repository`, choose **New branch…** on `origin/main` and name it. Confirm the dialog says Git sets `origin/main` as its upstream, the new branch shows its upstream's counts without a reload, and the palette lists **Rename <name>…** and **Delete <name>…** for it.
