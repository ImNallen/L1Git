# Check, download and install app updates

Use disposable repositories from `pnpm fixture`. The parent owns the desktop and native GUI session. Coordinate before launching any app. Record the checkout SHA and preserve screenshots and action transcripts outside the repository.

## Check availability and channels

1. Open the command palette with **Cmd/Ctrl+P** and choose **Open General settings**. In Updates, confirm the installed version, Stable or Nightly channel, and **Check for updates** action.
2. Confirm Settings stays first in the sidebar footer and a compact updater icon stays at its bottom-right in packaged releases. In a browser preview, focus the disabled updater and confirm the browser explanation. In a native development build, confirm the sidebar updater is absent and Settings shows the development explanation and manual release link. On non-AppImage Linux, confirm the package-manager explanation. Settings also has these explanations and a manual release link. These environments cannot install updates.
3. In a packaged release, choose **Check for updates** from the sidebar icon. Confirm checking, current, available, or a useful failure with **Retry check** without opening Settings. Confirm busy controls are disabled, status changes have polite announcements, and details appear on keyboard focus. Current and failed checks allow another check. Startup and hourly checks require no interaction. Neither check downloads an artifact.
4. Select Nightly, restart the test app, and confirm the preference survives. A missing preference defaults to the installed build's channel. Select Stable from a newer nightly and confirm that an older Stable release never offers a downgrade.
5. On availability, confirm the sidebar icon offers **Download update** directly. Open General settings separately and confirm rendered release notes appear as text, including any HTML-like text.

## Verify a disposable signed upgrade

Build a separate fixture app and signed successor from the checkout. The build uses a new ephemeral signing key, a unique `dev.l1.git.updater-fixture.*` identifier, and a loopback feed compiled only into the `updater-fixture` feature. It writes no private key file. Production IPC cannot select an endpoint, key, target version, or comparator. Do not override `HOME` or use a real repository.

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/updater-harness.mjs build 9854
```

On Linux, omit `DEVELOPER_DIR`. The script builds AppImages. Save the printed directory and open its `README.txt` and `harness.json`. They contain the exact app path, unique identifier, versions, feed, and launch commands. Start the feed in a retained process handle.

```sh
node scripts/updater-harness.mjs serve <printed-directory>
```

With the feed running, verify the packaged artifact through the real native updater without launching the GUI.

```sh
L1GIT_PACKAGED_FIXTURE_DIR='<printed-directory>' cargo test --locked -p l1-git packaged_fixture_feed_downloads_the_exact_signed_successor -- --ignored
```

This opt-in test checks the announced successor, signature, signed version, and exact packaged bytes. It does not install or restart.

On macOS, the parent launches the printed app with `open -n '<app-path>'`. On Linux, make the copied AppImage executable if needed and launch it directly. Only use repositories created for this run. The fixture starts at `0.1.0-nightly.20000101.1`; its signed successor is `0.1.0-nightly.20000101.2`.

1. Open Updates and check. Confirm the available successor version.
2. Click **Download update** in the sidebar. Confirm a disabled busy icon and a percentage in its keyboard focus details when the total is known. Without a total, confirm an indeterminate spinner. Settings also shows a byte count. Wait for the verified/downloaded state and **Restart and install**. Checking alone must never download or install.
3. Create a commit message in one fixture root. Load Amend with a nonempty draft set aside in a second root. Switch away so that one root is inactive.
4. Click the sidebar's **Restart and install** icon. Confirm the dialog names every root, counts current and amend-aside messages, and explicitly describes loss of unsaved messages. Click **Cancel**. Repeat through Updates settings and cancel with Escape. Return to both roots and confirm every draft remains intact.
5. Start amend loading, commit submission, or undo restoration and try restart before the result is applied. Confirm consent waits or refuses. After the task drains, try again. If the draft impact changed after the dialog opened, confirm that the app requires a fresh confirmation.
6. While any root has native repository work in progress, confirm restart. Installation must refuse without stopping Git. Confirm the verified download and every draft remain available for retry. Confirm failure details are available from the sidebar on keyboard focus. If the downloaded candidate changes or stops being downloaded while consent is open, confirm the dialog closes and requires a new request.
7. When work finishes, review the loss dialog and explicitly confirm **Discard drafts and restart**. While the install command is pending, confirm the consent action is disabled and repeated clicks send only one command. Confirm editing and repository operations are blocked during installation.
8. Wait for replacement and restart. Open Updates in the restarted app and confirm the installed version ends in `.2`. Read `Contents/Info.plist` on macOS or inspect the running AppImage as additional artifact evidence. A successful bundle or mocked UI test does not prove replacement.
9. Record `git status --porcelain`, `git ls-files -s`, `git for-each-ref`, and HEAD for both fixture roots. Verify that installation itself changed no repository bytes, refs, or index entries.

For an installation failure, move a copied test app to a location that cannot be replaced or use a disposable invalid-archive fixture in a test build. Confirm the app returns to **Restart and install**, preserves drafts, and admits repository work again. Do not change permissions on a real installation.

## Automated verification and evidence

Run `cargo test --locked -p l1-git` to exercise the real Tauri updater against ephemeral signed loopback fixtures. It covers correct bytes, corruption, wrong keys, absent and mismatched signed versions, newer-only comparison, stale completions, repository admission races, caller cancellation, and failed-install recovery. CI's macOS desktop job explicitly runs these tests because workspace default members exclude `src-tauri`.

Run `pnpm exec vitest run src/updates.test.ts src/commitDrafts.test.ts src/draftTasks.test.tsx src/components/UpdatesSettings.test.tsx src/actions.test.ts` for revision ordering, IPC validation, all-root loss consent from both entry points, task lifetimes, freeze/recovery, sidebar actions, progress, errors, stale consent, and duplicate confirmation. These mounted DOM tests do not prove native replacement or desktop layout.

Save the feed log, `harness.json`, old and successor app versions, screenshots before consent and after restart, and the repository comparisons. Stop only this run's feed and app. Keep the packaged artifacts and evidence until the parent finishes independent review.
