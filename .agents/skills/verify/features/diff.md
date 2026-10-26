# Read a file diff

## Sub-features

Opening a changed file from the inspector tree, unified and split layouts, binary and oversized notices, root-commit patches, Back to history, Escape, closing on commit change, a file's history, and blame.

## How to get to it (user POV)

Open the fixture repository. Select a commit in the history. In the inspector's changed-file tree, click a file row. The history pane shows that file's diff until you go back.

## Driving it with T3 preview

1. Select `feat(inspector): show commit message and changed paths`. Click `history.ts` in the tree. Confirm the region **Changes to history.ts**, the path `history.ts` in its toolbar, and a unified diff that replaces `"topological"` with `"first parent"` on line 2.
2. Click **Split**. Confirm old and new columns side by side with line numbers 1 to 3 in each. Click **Unified** to return.
3. Click `assets/icon.png`. Confirm the notice `Binary file. L1 Git does not display binary changes.`
4. Press Escape. Confirm the history returns and the tree row is no longer selected. Click `assets/icon.png` again and confirm the diff reopens.
5. Click **Back to history**. Confirm the history returns.
6. Open `graph.ts`, then click the inspector's parent hash. Confirm the diff closes and the inspector shows `Merge branch feat/history`.
7. Select `docs: start the local Git fixture` and click `README.md`. Confirm an all-added diff with the single line `# L1 demo`.
8. Select `feat(inspector): show commit message and changed paths`, click `history.ts`, then click **History**. Confirm two rows, `3de65de` and `285b405`, the same list as `git log --follow --oneline <commit> -- history.ts`, with the first row selected and its diff below.
9. Click the `285b405` row. Confirm an all-added diff of three lines. Click the list, then press Home and Down. Confirm the selection moves with the keys, the selected row takes the accent tint and a 2px left bar while the list has focus, and no outline appears.
10. Click **Blame**. Confirm three bands above lines 1, 2, and 3, naming `285b405`, `3de65de`, and `285b405`, which match `git blame <commit> -- history.ts`. Press Tab from **Blame** and confirm the first band takes the tint and left bar.
11. Click the `285b405` band. Confirm the diff closes and the graph selects `feat(history): add bounded repository history`.
12. Open `assets/icon.png` in the inspector commit and click **Blame**. Confirm the notice `Binary file. L1 Git does not blame binary files.`
13. Switch between **Unified**, **Split**, **History**, and **Blame**. Confirm each view replaces the last one. Press Escape from Blame and confirm the history returns with the commit still selected.
14. Select a worktree row and open a file. Confirm **History** and **Blame** are off and their tooltip asks for a commit. Confirm a bar above each hunk and the line bar above the diff, which [changes](changes.md) steps 29 to 37 drive. Commit and comparison diffs show neither.

## Gotchas

History starts at the selected commit, not at HEAD, so compare it with `git log --follow <commit> -- <path>`. The fixture has no rename. To see history reach past one, make a scratch repository that renames a file and add it. The row from before the rename names the old path, and its diff opens under that path. For a large blame, open `src/hot/history.ts` in `pnpm fixture:large` from `feat: revise src/graph/module-01.ts (58001)`. Its 402 lines show 402 bands. The first commit, `568b3bb`, wrote the first and last lines, and both of its bands are off because that commit is older than the loaded history. Blame bands are `@pierre/diffs` line annotations, so they sit in the page and their text is readable without the shadow root.

Diffs use the same base as the inspector: the first parent, or the empty tree for a root commit. Patches above 1 MiB show their size instead of a diff; create a large file in a scratch repository to see it, because the fixture has none. The diff lives in a shadow root, so read its lines with a screenshot or the host's `shadowRoot`, not the page text. At narrow widths, open the inspector overlay to pick a file; the overlay stays open over the diff until you toggle it.
