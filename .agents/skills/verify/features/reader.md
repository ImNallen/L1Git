# Read real repository data

## Sub-features

Canonical roots, linked worktrees, exhaustive HEAD states, local and remote refs, bounded history, commit details, file patches, branch overviews, fetch, fast-forward, and transport validation.

## How to get to it (user POV)

Every Add, Refresh, and commit selection reaches the shared Rust Git core. Launch and interval fetches, **Fetch**, and **Fast-forward (N)** reach the overview, fetch, and fast-forward operations. Native Tauri commands and the development bridge call the same functions.

## Driving it with the terminal

Run `cargo test --locked` to build temporary repositories and check normalization, distinct linked worktrees, fetched remote refs, unborn and detached HEAD, the newest-50,000 history window, invalid input, first-parent merge details, and file patches for text, binary, oversized, root, unchanged, and pathspec-magic paths. The `sync` tests check branch roles and upstream states, fast-forwards of free, checked-out, linked, and partial-clone branches, and skips for moved, diverged, dirty, and mid-rebase branches. They also check per-remote auth failures and timeouts through fake ssh commands, and that two fetches of one repository never overlap. No external remote is contacted.

Run `pnpm test` to start a real isolated Rust bridge, create the deterministic fixture, parse HTTP responses with the frontend schemas, find a remote branch tip in the full history, read merge details, and read text, binary, and root file patches. Against the `sync` fixture, they read local refs, fetch, fast-forward the ready branch, and receive skips for the dirty and diverged branches. A snapshot must answer while a slow fetch is in flight. The tests reject other origins, missing origins, malformed requests, and nonexistent commands. Graph and recents tests run in the same command.

Run `pnpm build` and `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer pnpm tauri build --debug` for the frontend and native packaging checks.

## Gotchas

These checks prove data and build behavior. They do not prove visible tree expansion, dialog focus, native window chrome, or picker cancellation. The other feature journeys supply those checks. The core and bridge are the default Rust workspace members so Linux data tests do not need Tauri's native GUI dependencies.
