---
name: verify
description: Verify L1 Git through its real browser preview, local Rust core, and native Tauri app after UI or repository changes.
---

# Verify L1 Git

## Launch

Read the [feature map](features/README.md). From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm fixture`. Save the printed paths. The fixture has nine commits, three local branches, three remote branches, a merge, a squash merge of `feat/squashed`, an annotated tag `v0.1.0` on the theme commit, an unborn repository, and a detached linked worktree. Its separate `sync` repository has a branch that falls behind after a fetch, a behind branch checked out in a dirty linked worktree, and a diverged branch. It creates and modifies only its own temporary repositories.

For perf probes or large-history journeys, also run `pnpm fixture:large` and save its printed `repository` and `worktree` paths. It creates 60,000 commits, `main` plus 199 local branches in nested folders, 400 remote-tracking branches under `origin` and `upstream` plus `origin/HEAD`, and 50 annotated tags. Every 40th commit on the first-parent line of `main` is a merge. Select `archive/old-tip` to check the notice for a branch whose tip is older than the loaded history. Use `src/hot/history.ts` for file history and blame. More than 500 commits edit it, and its 400 lines were last changed by 400 different commits. The `worktree` path is a linked worktree with one modified and one untracked file. Every run creates the same commit IDs, so `rev-parse main` in the repository matches across runs. Creation should take under 30 seconds. Its remotes set `skipFetchAll`, so a fetch in the app contacts nothing.

Run `pnpm dev`. Wait for both `L1 Git development bridge on http://127.0.0.1:9417` and Vite's `http://127.0.0.1:1422/` message. Keep the process handle for cleanup. Ports can be isolated with `L1GIT_DEV_PORT=1423 L1GIT_BRIDGE_PORT=9418 pnpm dev`. Use a fresh browser profile or origin for an empty saved list. Never clear the user's existing recents to obtain an empty state.

For browser interaction, prefer T3's `preview_status`, `preview_open`, and snapshot-based interaction tools. Read an existing unclaimed tab or open your own tab at the Vite URL. Do not drive a tab the user currently owns. Use another available browser driver only when T3 preview is unavailable.

The browser preview uses the real Rust implementation. API checks prove the reader contract, not the rendered user journeys. Do not substitute internal React state changes or fabricated snapshots for visible interactions.

## Doctor

Confirm that the Vite page title is `L1 Git` and that the terminal process belongs to this checkout. A read-only HTTP check is `curl --fail --silent http://127.0.0.1:1422/`. Confirm the expected app title in its response. Run `pnpm test` for a real bridge roundtrip if the repository reader looks wrong. Tests start an isolated bridge on an available loopback port and clean up their own fixtures.

If the Add dialog says the reader is unavailable, check the bridge log and both ports. `pnpm dev:web` starts only Vite and is intended for Tauri, whose commands replace the browser bridge.

## Drive

Follow the mapped journeys with accessible names from live snapshots. Start with [Add and restore repositories](features/repositories.md), then [Browse the commit graph](features/history.md), then [Inspect a commit](features/inspector.md), then [Read a file diff](features/diff.md), then [Change appearance](features/appearance.md), then [Update behind branches](features/overview.md), then [Stage, unstage, commit, discard, and undo](features/changes.md), then [Create, rename, delete, and check out branches, and create and delete tags](features/refs.md). Then follow [Check, download and install app updates](features/updates.md) with a disposable packaged app and parent-owned desktop session. The separate [reader contract](features/reader.md) has automated coverage.

Use **Cmd/Ctrl+O** to add a repository, **Escape** to cancel, **Cmd+F** on macOS or **Ctrl+F** elsewhere to open loaded-history search, and **Cmd+P** on macOS or **Ctrl+P** elsewhere to open the command palette. **Cmd+Z** on macOS or **Ctrl+Z** elsewhere undoes the last write, and adding Shift redoes it. Escape also closes an open file diff. The native dialog traps focus. Pane separators support pointer dragging and arrow keys. At narrow widths the inspector starts hidden; **Toggle commit inspector** opens it as an overlay.

Run `cargo test --locked`, `cargo test --locked -p l1-git`, `pnpm test`, `pnpm build`, `pnpm format:check`, and `cargo fmt --all --check` after code changes. No network account is required.

## Evidence

Save screenshots and an action transcript outside the repository, such as `/tmp/l1git-verification-<run-id>/`. Record the checkout SHA, fixture paths, viewport, selected branch, and before/after HEAD. Capture empty and loaded screens, the repository toolbar before and after **Fast-forward (N)**, a remote branch tip selected from the sidebar, the merge inspector, unified and split file diffs, the binary notice, and a failed Add dialog. For persistence, capture the list before and after reload. To prove that only the intended refs moved, record `git -C <worktree> for-each-ref refs/heads refs/remotes`, `symbolic-ref HEAD`, and `status --porcelain` for every fixture worktree before and after the journeys. Add `git ls-files -s` for any journey that stages, unstages, or undoes. The reader journeys move nothing. A fetch moves only remote-tracking refs, and a fast-forward moves only the branches it reports as advanced.

Report browser, reader, build, and native results separately. A successful bundle does not prove the native picker or window dragging. The implementation baseline passes reader tests and builds. The browser journeys and native interactions require a live drive and must not be reported as previously verified.

## Native checks

Run `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri dev` on macOS. It uses Vite on port 1422, so stop a browser development instance on that port first. Verify real traffic lights, dragging the titlebar, and **Browse…** selecting a repository. Cancel the native picker and confirm that the current repository and saved list remain unchanged. Quit and restart to verify the native saved list separately from the browser's list.

Run `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri build --debug` for the packaged app at `target/debug/bundle/macos/L1 Git.app`. On other platforms omit `DEVELOPER_DIR` and install the platform's Tauri prerequisites.

## Cleanup

Stop only the development or native process started by this run, using its process handle. Keep screenshots and transcripts. Remove only this run's temporary fixtures if they are no longer needed. Confirm the evidence survives cleanup. Use `pstack:maintain-verification-skill` when the app's behavior or controls change.
