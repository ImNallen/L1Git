# Inspect a commit

## Sub-features

Full commit metadata, SHA copy, parent navigation, changed paths, merge policy, and inspector resizing or hiding.

## How to get to it (user POV)

Open the fixture repository and select **All branches**. Use **Toggle commit inspector** if the pane is hidden. Select a commit by its description button in the history table.

## Driving it with T3 preview

1. Select the description whose accessible name begins `Merge branch feat/history`. Confirm the inspector shows its full SHA, author `N Allen`, two parent links, and changed paths `graph.ts` and `history.ts`.
2. Confirm the comparison says **Compared with the first parent**. Click either parent hash. Confirm the inspector changes to that exact parent SHA.
3. Select `docs: start the local Git fixture`. Confirm **Root commit**, an empty-tree comparison, and the added `README.md` path.
4. Click **Copy commit SHA**. Confirm the copied status and clipboard content when the driver has clipboard access.
5. Drag **Resize commit inspector**, or focus the separator and use arrow keys. Confirm a width change. Hide and reopen the inspector with its controls.
6. Resize below 1100 pixels. Confirm the inspector hides and its toggle reopens it as an overlay. Confirm horizontal history scrolling remains usable.

## Gotchas

Changes use the first parent for every non-root commit. Renames are separate deleted and added paths. Parent details can be read outside the loaded history. Clipboard access can be unavailable in some browser drivers; record that limitation and verify it natively. Do not replace a failed clipboard action with an internal state setter.
