# Browse branch history

## Sub-features

Local and remote branch sections, branch filtering, bounded history, parent graph, loaded-history search, and local refresh.

## How to get to it (user POV)

Add the fixture's `repository` path. Expand **Local branches** and **Remote branches** in the sidebar. The default history reads local and remote branches plus HEAD. Internal refs and stashes are excluded.

## Driving it with T3 preview

1. Confirm six loaded commits and five branches, with two local and three remote refs. `origin/HEAD` must not appear.
2. Select the sidebar branch button named **feat/history**. Confirm three commits and the selected branch highlight. The toolbar still shows `main` as checked-out HEAD.
3. Select **origin/feat/remote-inspector**. Confirm its newest subject is `feat(inspector): show commit message and changed paths`. Confirm HEAD is unchanged with Git.
4. Select **All branches**. Confirm the merge has two graph edges to real parents and the graph rejoins their ancestor.
5. Focus **Search loaded history**. Search `graph`, then a known short SHA, then a nonexistent subject. Confirm matching rows, an explicit loaded-history label, and the empty result. Connections are hidden while filtering.
6. Clear search with **Clear history search** or Escape. Use **Filter repositories and branches** to find `remote-inspector`, then clear the filter.
7. Create an additional commit only in the fixture with Git. Click **Refresh**. Confirm it appears and that the footer describes a local read, not a fetch.
8. Switch rapidly between saved repositories. Confirm the final view belongs to the last selected root.

## Gotchas

The default window holds at most 200 commits. Selecting a branch asks Rust for that branch's own bounded history. Search covers loaded subjects, authors, emails, and IDs. It does not query older commits. A fixture used by another journey may have additional commits; recreate it to recover the six-commit baseline. GitHub metadata displays `l1-family/l1-git` without a network request.
