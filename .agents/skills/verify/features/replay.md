# Cherry-pick or revert a commit

Start one from History or the palette, or finish one started in a terminal.

## Start one in the app

### Prepare

Run `pnpm fixture:merge` and save the printed JSON. Start the app on a port you have not used, as **Prepare** below says, and add `clean.path` and `conflict.path`. In each, `incoming` holds **Incoming change** and `main` holds **Local change**. `conflict.txt` holds `current` on `main`, `notes.txt` is untracked, and `ignored.txt` is ignored. Keep the same raw evidence as below, and record HEAD before and after each step.

Open the commit menu by right-clicking a row, or by selecting it and pressing **Shift+F10**.

### Clean pick and revert

1. In `clean.path`, open the menu on **Incoming change**. It lists **Cherry-pick onto main…** and **Revert on main…** after **Create tag…**. Choose the first. The dialog names the full commit ID and subject, `refs/heads/main` and its ID, and **Applies cleanly. L1 Git will commit it straight away, and Undo removes it.** HEAD has not moved.
2. Click **Cherry-pick**. The dialog closes with no notice, and the Undo button reads **Cherry-pick “Incoming change”**. HEAD has one new commit, with Git's author and message, and no marker.
3. Click Undo. HEAD is the commit from before, `incoming.txt` is gone, and `notes.txt` keeps its bytes. Click Redo. HEAD is the same new commit, with `incoming.txt` back.
4. Open the menu on **Local change**, and choose **Revert on main…**. Click **Revert**. HEAD has a new commit reading `Revert "Local change"`, `conflict.txt` holds `base`, and the Undo button reads **Revert “Local change”**.
5. Select **Incoming change** again, press **Cmd+P** or **Ctrl+P**, and type `Cherry-pick`. The palette lists **Cherry-pick onto main…**. Press Enter. The same dialog opens, now reading **These changes are already there, so there is nothing to apply.**, with **Cherry-pick** disabled. Select the worktree row, and the palette offers neither entry.

### Conflicts

1. In `conflict.path`, cherry-pick **Incoming change** from the menu. The dialog reads **Will conflict in: conflict.txt. You resolve it in the app, then finish or abort.** Click **Cherry-pick**. The dialog closes, no failure notice shows, and the strip reads **Cherry-picking** with the short commit ID and subject, **onto main**, and **1 file still has a conflict.** `CHERRY_PICK_HEAD` exists and HEAD has not moved.
2. Resolve as **Resolve and finish** below says, and click **Finish cherry-pick**. The Undo button reads **Cherry-pick “Incoming change”**, the same label as a clean pick. Click Undo. HEAD is the commit from before, `conflict.txt` holds `current`, and no strip returns.
3. Commit another change to `conflict.txt` from the shell, and refocus. Revert **Local change** from the menu. The strip reads **Reverting** with the commit **on main**. Click **Abort revert…**, then **Abort revert**. HEAD is unchanged, the marker is gone, and `conflict.txt` holds the later change.

### Refusals

Each one shows its reason with the confirm button disabled and nothing else offered, and changes nothing.

1. Merge commit. In `clean.path`, run `git branch merged $(git commit-tree "HEAD^{tree}" -p HEAD -p incoming -m "A merge commit")`, refocus, and cherry-pick **A merge commit**.
2. Already on the branch. Cherry-pick **Local change**, and the answer names `main`. Revert **Incoming change** before picking it, and the answer says it is not on `main`.
3. Staged change. Run `git add notes.txt`, refocus, and cherry-pick any other commit. The answer names `notes.txt`. Run `git reset`.
4. Ignored file. In the `linked` worktree, create a branch, run `git add -f ignored.txt` with different bytes, commit, and switch back. Refocus and cherry-pick that commit. The answer names `ignored.txt`, and the file in `clean.path` keeps its bytes.
5. Detached HEAD. Run `git switch --detach` and refocus. The entries read **Cherry-pick onto current branch…** and **Revert…**, and the review says to check out a branch.

### A hook stops a clean pick

Point `core.hooksPath` at a folder with a `prepare-commit-msg` that prints a line to stderr and exits 1. Cherry-pick a commit whose review reads **Applies cleanly**. The dialog closes, no failure notice shows, and the hook's line and the note that the result is staged show under the strip. `CHERRY_PICK_HEAD` exists and HEAD has not moved. The strip reads **No conflicts**. Remove the hook and click **Finish cherry-pick**, which uses the suggested message. The commit keeps the picked commit's author, and the output is gone.

### Other checks

1. Linked worktree. Select the `linked` worktree's row, then a commit. The entries name `linked`, the review's destination is `refs/heads/linked`, and the write lands in that worktree.
2. Small window. At 1100 by 640, the dialog fits the window and scrolls, and **Cherry-pick** can be reached, even with forty conflicting paths.
3. Not idle. While a merge or a stopped pick is in progress, the menu entries are disabled and the palette has neither.

## Finish or abort one started in a terminal

### Prepare

Create disposable repositories outside this checkout, and use an origin with an empty saved list. A port you have not used before gives one: `L1GIT_DEV_PORT=1437 L1GIT_BRIDGE_PORT=9437 L1GIT_UNDO_DIR=<scratch>/undo pnpm dev`. Do not reuse the user's repositories, and do not clear saved recents.

For a pick, create `base` with `conflict.txt` and `notes.txt`. On branch `source`, change one line of `conflict.txt`, add `added.txt`, and commit with a subject and a body. On `main`, change the same line and commit. Run `git cherry-pick source` from the shell. It exits 1. For a revert, commit that change on `main`, then a later commit that changes the same line, and run `git revert --no-edit HEAD~1`. For a sequence, add a second commit on `source` and run `git cherry-pick source~1 source`.

Keep raw evidence from `git rev-parse HEAD`, `git status --porcelain`, `git ls-files -u`, `git log -1 --format='%H %an %s%n%b'`, and `git show-ref --exists CHERRY_PICK_HEAD` or `REVERT_HEAD`. Exit 0 means the marker exists and exit 2 means it does not. Record HEAD before and after each step.

### Resolve and finish

1. Add the repository, or refocus the window if it is open. Confirm the strip under the toolbar reads **Cherry-picking**, the short commit ID and subject in a violet chip, **onto**, and `main` in a blue chip, with **1 file still has a conflict.** Nothing has changed in Git. **Finish cherry-pick** is disabled and says **Resolve every conflicted file first.** on hover.
2. Click **0 of 1 resolved** in the strip. The inspector is titled **Cherry-pick**, shows **Into** `main` and **From** the commit, and says Finish adds one commit with that commit's changes. The Commit box and Stash are absent. **Commit message** shows the picked commit's subject and body as **Suggested**, and the footer says Finish can be undone like a commit. Click `conflict.txt` under **Needs resolution**. Accept a side in Choices. **Finish cherry-pick** stays disabled with **Save your unsaved conflict results first.**, and **Abort cherry-pick…** stays enabled.
3. Click **Save result**, then **Mark resolved**. Undo restores the three index stages and Finish is disabled again. Redo resolves the path.
4. Replace the summary with a space and confirm Finish says **Write a commit message first.** Click **Edited · Use suggested**, and click **Finish cherry-pick**. The strip closes. `git log -1` shows the message and the picked commit's author. The marker is gone. The Undo button names **Cherry-pick** and the message.
5. Click Undo. HEAD is the commit from before the pick, `added.txt` is gone, `conflict.txt` holds the current side, and no strip returns, because Undo does not reopen the conflict. Click Redo. HEAD is the same finished commit, with its files.

### Abort

1. Start another pick from the shell, with an untracked file beside it, and refocus. In the resolver, choose a side and leave it unsaved. Click **Abort cherry-pick…**. Under **Discarded** the dialog names `conflict.txt` as an **unsaved result draft**, under **Kept** the message draft, untracked and ignored files, and it says a staged change outside the cherry-pick's files blocks Abort and that this cannot be undone. Click **Keep cherry-picking** and confirm nothing changed.
2. Open it again and click **Abort cherry-pick**. A notice says the pick was aborted, Commit and Stash return, HEAD is unchanged, the marker is gone, tracked files match HEAD, and the untracked file keeps its bytes.

### Revert

Repeat both parts in the revert repository. The strip reads **Reverting**, with **Finish revert** and **Abort revert…**. The resolver says Incoming holds the reverse of the commit. The suggested message is Git's `Revert "..."` with `This reverts commit ...`. A finished revert has you as author.

### Other cases

1. Empty result. Start a revert from the shell, run `git checkout --ours conflict.txt`, restore every other path from HEAD, and run `git add` on them. Refocus. The strip says the staged result matches HEAD and offers **Abort revert…** with no Finish, and the inspector has no message fields. Abort keeps HEAD.
2. Refusing hook. With every path resolved, add a `pre-commit` hook that prints a line and exits 1. Click Finish. The write notice says the hook stopped the commit, the hook's output shows under the strip, HEAD and the marker are unchanged, and the message stays. Remove the hook and click Finish again. It lands.
3. Sequence. After the multi-commit pick stops, a neutral strip reads **A cherry-pick of several commits is in progress**, says it started outside L1 Git, and names `git cherry-pick --continue` and `git cherry-pick --abort`. There is no Finish or Abort. The resolver still edits the conflict.
4. Amend. With Amend on and a draft set aside, start a pick from the shell. Finish says **Turn off Amend in the commit message first.** The inspector's commit message says Amend is on and offers **Turn off Amend**, which restores the draft.

Automated coverage lives in `crates/git-core/tests/replays.rs`, `src/repositories.integration.test.ts`, `src/App.replay.pin.test.tsx`, `src/components/ReplayPanel.test.tsx`, `src/components/OperationStrip.test.tsx`, and `src/components/ReplayReviewDialog.test.tsx`. These do not replace this journey in the browser and the native app.
