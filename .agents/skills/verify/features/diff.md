# Read a file diff

## Sub-features

Opening a changed file from the inspector tree, unified and split layouts, binary and oversized notices, root-commit patches, Back to history, Escape, and closing on commit change.

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

## Gotchas

Diffs use the same base as the inspector: the first parent, or the empty tree for a root commit. Patches above 1 MiB show their size instead of a diff; create a large file in a scratch repository to see it, because the fixture has none. The diff lives in a shadow root, so read its lines with a screenshot or the host's `shadowRoot`, not the page text. At narrow widths, open the inspector overlay to pick a file; the overlay stays open over the diff until you toggle it.
