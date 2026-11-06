# Finish or abort a cherry-pick or revert started in a terminal

## Prepare

Create disposable repositories outside this checkout, and use an origin with an empty saved list. A port you have not used before gives one: `L1GIT_DEV_PORT=1437 L1GIT_BRIDGE_PORT=9437 L1GIT_UNDO_DIR=<scratch>/undo pnpm dev`. Do not reuse the user's repositories, and do not clear saved recents.

For a pick, create `base` with `conflict.txt` and `notes.txt`. On branch `source`, change one line of `conflict.txt`, add `added.txt`, and commit with a subject and a body. On `main`, change the same line and commit. Run `git cherry-pick source` from the shell. It exits 1. For a revert, commit that change on `main`, then a later commit that changes the same line, and run `git revert --no-edit HEAD~1`. For a sequence, add a second commit on `source` and run `git cherry-pick source~1 source`.

Keep raw evidence from `git rev-parse HEAD`, `git status --porcelain`, `git ls-files -u`, `git log -1 --format='%H %an %s%n%b'`, and `git show-ref --exists CHERRY_PICK_HEAD` or `REVERT_HEAD`. Exit 0 means the marker exists and exit 2 means it does not. Record HEAD before and after each step.

## Resolve and finish

1. Add the repository, or refocus the window if it is open. Confirm **Cherry-pick in progress** above the history, with the full commit ID and subject, the destination branch and its ID, and **1 unresolved path**. Nothing has changed in Git. The Commit box and Stash are absent, and **Finish cherry-pick** is disabled.
2. Click **Review staged result and conflicts**, then `conflict.txt`. Accept a side in Choices. Click **Use suggested message**. The subject and body fill the two fields. **Finish cherry-pick** stays disabled, the panel says unsaved results must be saved, and **Abort cherry-pick…** stays enabled.
3. Click **Save result**, then **Mark resolved**. Undo restores the three index stages and Finish is disabled again. Redo resolves the path.
4. Clear the message and confirm Finish is disabled. Fill it again and click **Finish cherry-pick**. The panel closes. `git log -1` shows the message and the picked commit's author. The marker is gone. The Undo button names **Finish cherry-pick** and the message.
5. Click Undo. HEAD is the commit from before the pick, `added.txt` is gone, `conflict.txt` holds the current side, and no panel returns, because Undo does not reopen the conflict. Click Redo. HEAD is the same finished commit, with its files.

## Abort

1. Start another pick from the shell, with an untracked file beside it, and refocus. In the resolver, choose a side and leave it unsaved. Click **Abort cherry-pick…**. The dialog names `conflict.txt` as a draft it discards, says a staged change outside the affected paths blocks Abort, and says the action cannot be undone. Cancel and confirm nothing changed.
2. Open it again and click **Discard cherry-pick and abort**. The panel says the pick was aborted, Commit and Stash return, HEAD is unchanged, the marker is gone, tracked files match HEAD, and the untracked file keeps its bytes.

## Revert

Repeat both parts in the revert repository. The panel reads **Revert in progress**, with **Finish revert** and **Abort revert…**. The resolver says Incoming holds the reverse of the commit. The suggested message is Git's `Revert "..."` with `This reverts commit ...`. A finished revert has you as author.

## Other cases

1. Empty result. Start a revert from the shell, run `git checkout --ours conflict.txt`, restore every other path from HEAD, and run `git add` on them. Refocus. The panel says the staged result matches HEAD and offers **Abort revert…** with no Finish and no message fields. Abort keeps HEAD.
2. Refusing hook. With every path resolved, add a `pre-commit` hook that prints a line and exits 1. Click Finish. The write notice says the hook stopped the commit, the panel shows what the hook printed, HEAD and the marker are unchanged, and the message stays. Remove the hook and click Finish again. It lands.
3. Sequence. After the multi-commit pick stops, the area reads **Git operation in progress** and names `git cherry-pick --continue` and `git cherry-pick --abort`. There is no Finish or Abort. The resolver still edits the conflict.
4. Amend. With Amend on and a draft set aside, start a pick from the shell. The panel says Amend is on and offers **Turn off Amend**, which restores the draft.

Automated coverage lives in `crates/git-core/tests/replays.rs`, `src/repositories.integration.test.ts`, `src/App.replay.pin.test.tsx`, and `src/components/ReplayPanel.test.tsx`. These do not replace this journey in the browser and the native app.
