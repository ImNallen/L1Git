# Read real repository data

## Sub-features

Canonical roots, linked worktrees, exhaustive HEAD states, local and remote refs, full-ref selection, bounded history, commit details, file patches, and transport validation.

## How to get to it (user POV)

Every Add, Refresh, branch selection, and commit selection reaches the shared Rust Git reader. Native Tauri commands and the development bridge call the same functions.

## Driving it with the terminal

Run `cargo test --locked` to build temporary repositories and check normalization, distinct linked worktrees, fetched remote refs, unborn and detached HEAD, branch history outside the initial window, invalid input, first-parent merge details, and file patches for text, binary, oversized, root, unchanged, and pathspec-magic paths. No external remote is contacted.

Run `pnpm test` to start a real isolated Rust bridge, create the deterministic fixture, parse HTTP responses with the frontend schemas, browse a remote ref, read merge details, and read text, binary, and root file patches. The tests reject other origins, missing origins, malformed requests, and nonexistent commands. Graph and recents tests run in the same command.

Run `pnpm build` and `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri build --debug` for the frontend and native packaging checks.

## Gotchas

These checks prove data and build behavior. They do not prove visible tree expansion, dialog focus, native window chrome, or picker cancellation. The other feature journeys supply those checks. The core and bridge are the default Rust workspace members so Linux data tests do not need Tauri's native GUI dependencies.
