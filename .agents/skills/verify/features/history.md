# Browse the commit graph

## Sub-features

Local and remote branch sections, branch filtering, the full graph of every branch, ref labels beside the graph, author nodes, jumping to a branch tip from the sidebar, windowed rows, loaded-history search, and local refresh.

## How to get to it (user POV)

Add the fixture's `repository` path. L1 Git opens on the repository screen. Expand **Local branches** and **Remote branches** in the sidebar. The graph always reads local and remote branches, tags, and HEAD. Columns are **Branch / Tag**, **Graph**, and **Commit message**. Internal refs and stashes are excluded.

## Driving it with T3 preview

1. Confirm six loaded commits and five branches, with two local and three remote refs, and the summary label `All branches`. `origin/HEAD` must not appear.
2. Select the sidebar branch button named **feat/history**. Confirm the history still lists all six commits, the row at the `feat/history` tip is selected, and the sidebar branch is highlighted. The toolbar still shows `main` as checked-out HEAD.
3. Select **origin/feat/remote-inspector**. Confirm the selected row's subject is `feat(inspector): show commit message and changed paths` and the inspector shows that commit. Confirm HEAD is unchanged with Git.
4. Click another commit row. Confirm the sidebar highlight clears. Click the same sidebar branch again and confirm its tip is selected again.
5. Confirm the merge has two graph edges to real parents and the graph rejoins their ancestor.
6. Confirm the labels left of the graph. The merge row shows `main` with the checked-out icon and `+1` for `origin/main`. The `feat/history` tip shows `feat/history` and `+2` for the `detached-worktree` worktree and `origin/feat/history`. The theme commit shows the `v0.1.0` tag. Each badge's left border matches its row's lane color, and long names ellipsize inside the column. Each non-merge node shows the initials `NA`, and the merge node is a small hollow circle. Click a row's label or graph node and confirm that commit is selected.
7. Focus **Search loaded history**. Search `graph`, then a known short SHA, then a nonexistent subject. Confirm matching rows, an explicit loaded-history label, and the empty result. Connections are hidden while filtering. With a search active, select a sidebar branch and confirm the search clears.
8. Clear search with **Clear history search** or Escape. Use **Filter repositories and branches** to find `remote-inspector`, then clear the filter.
9. Create an additional commit only in the fixture with Git. Click **Refresh**. Confirm it appears while the checked-out branch remains unchanged.
10. Switch rapidly between saved repositories. Confirm the final view belongs to the last selected root.

To check scrolling, use a repository with more commits than fit on screen. Scroll the history away from a branch tip, then select that branch in the sidebar. Confirm the history scrolls so the tip row sits near the middle. Selecting a row that is already visible never scrolls. Only the visible rows and a small margin exist in the DOM, and the table reports the full count in `aria-rowcount`.

## Gotchas

The graph holds at most the newest 50,000 commits. Past that, the summary reads `Newest 50,000 commits`, and selecting a branch whose tip is older shows the notice `<branch> is older than the newest 50,000 loaded commits.` Search covers loaded subjects, authors, emails, and IDs. It does not query older commits. A fixture used by another journey may have additional commits; recreate it to recover the six-commit baseline. GitHub metadata displays `l1-family/l1-git` without a network request.
