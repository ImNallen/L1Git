# Release L1 Git

L1 Git publishes a universal macOS DMG and Linux x86_64 AppImage and deb to [GitHub Releases](https://github.com/ImNallen/L1Git/releases). Install Git separately and keep it available on `PATH`. Windows and an updater client are outside this workflow. Signed updater downloads and feeds are published for a future client integration.

## Publish a nightly

The workflow checks eligibility at minute 17 each hour. A scheduled nightly requires at least six hours since the last published nightly and additional commits on main. GitHub can delay scheduled runs.

To bypass both checks, dispatch from main:

```sh
gh workflow run release.yml --repo ImNallen/L1Git --ref main -f channel=nightly
```

Nightly versions use the latest stable version with its patch increased, followed by `-nightly.YYYYMMDD.N`. Before the first stable, the checked-in version supplies the base. The date is UTC and `N` is the workflow run number. Nightlies are GitHub prereleases.

## Publish stable from the latest nightly

Dispatch from main to rebuild the exact commit recorded by the latest published nightly:

```sh
gh workflow run release.yml --repo ImNallen/L1Git --ref main -f channel=stable
```

The default version is that nightly's plain `X.Y.Z`. To override it:

```sh
gh workflow run release.yml --repo ImNallen/L1Git --ref main -f channel=stable -f version=0.2.0
```

Overrides accept plain `X.Y.Z`, without a leading `v`. Every stable version must exceed the highest published stable version. The nightly tag must still resolve to its recorded source SHA, and that commit must belong to main. Promotion reruns full CI on that source and builds new packages with the stable version.

## Publish a hand-picked stable commit

Push a plain stable tag to select a commit independently of main or the latest nightly:

```sh
git tag v0.2.1 <commit>
git push origin v0.2.1
```

The tagged commit must pass full CI. Its version must exceed the latest published stable version. Nightly tag pushes do not trigger publication.

## Configure signing

Real publication requires all seven repository secrets. Missing inputs stop the plan job before builds start. The preflight checks presence only.

| Secret                               | Value to provide                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Dedicated L1Git updater private key, stored as a repository secret.              |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the updater key.                                                    |
| `APPLE_CERTIFICATE`                  | Base64-encoded Developer ID Application `.p12` certificate with its private key. |
| `APPLE_CERTIFICATE_PASSWORD`         | Password for the `.p12` export.                                                  |
| `APPLE_ID`                           | Apple ID authorized to notarize.                                                 |
| `APPLE_PASSWORD`                     | App-specific password for that Apple ID.                                         |
| `APPLE_TEAM_ID`                      | Developer team ID associated with the certificate.                               |

Set them through the repository's Actions secret settings. The dedicated updater public key is `scripts/updater-public-key.txt`. Keep an offline backup of the private key and password. This implementation never reads the maintainer's private-key files.

The release-only config enables `bundle.createUpdaterArtifacts` and supplies `plugins.updater.pubkey`. Installed-app update checks and UI require a separate client integration. The desktop crate declares the workspace `serde_json` dependency because Tauri generates references to it when embedding plugin configuration.

For macOS publication, the temporary config sets `bundle.macOS.signingIdentity` to `null`, removing the checked-in ad hoc identity. Tauri imports the certificate and infers its signing identity. The workflow requires a Developer ID signature for the supplied team, validates the notarization staple on the app, submits the DMG for notarization, and staples and validates the DMG. Failure blocks publication. Development versions and signing settings stay unchanged.

## Validate release changes in a pull request

Changes to the release workflow, CI, scripts, package inputs, Tauri sources, or this guide run packaging for both platforms. PR jobs have read permissions, skip every repository-secret step, and never publish. macOS packages use ad hoc signing. The plan job generates a disposable updater key with the pinned Tauri CLI. Its `dry-run-signing` artifact is intentionally public test material, shared by both builds and the verifier. It is never trusted for publication and is retained only to recover this run. A full rerun restores that key instead of generating a different one.

Download the `bundles-macos-universal` and `bundles-linux-x86_64` workflow artifacts. The read-only verification job requires the DMG, app archive, AppImage, deb, and both updater signatures. It also checks release metadata, sizes, and SHA-256 hashes. The app archive and AppImage signatures must cryptographically bind both their bytes and the planned application version. The generated `latest.json` and checksum manifest are workflow artifacts. On publication, `release-manifest.json` is also a release download with source, version, workflow revision, run identity, promotion source, and hashes.

The macOS check inspects both the DMG and updater app archive. It requires arm64 and x86_64 executable slices, the planned app version, and identical app metadata and executable inside the mounted DMG. Linux checks deb version and architecture, extracts both packages, checks their ELF architecture, and starts each under Xvfb for 15 seconds. A successful smoke check means the process stays running without known loader or panic errors. It does not exercise every Git operation or prove behavior on every Linux distribution.

Run the policy and publication tests locally:

```sh
pnpm test:release
```

These tests also run in ordinary `pnpm test` and CI. CI accepts an optional `source_sha` input, and both CI jobs check out that source. Release scripts and their tests come from the workflow revision when checking or building older source. Existing checks and packaging use the selected source's application code and lockfiles.

## Read the updater feeds

| Channel | Feed                                                                      |
| ------- | ------------------------------------------------------------------------- |
| Stable  | `https://github.com/ImNallen/L1Git/releases/latest/download/latest.json`  |
| Nightly | `https://github.com/ImNallen/L1Git/releases/download/nightly/latest.json` |

Every versioned release includes `latest.json` with `darwin-aarch64`, `darwin-x86_64`, and `linux-x86_64`. Both macOS entries use the same universal `.app.tar.gz`. Linux uses the AppImage. Each entry includes the validated updater signature and a URL to an immutable versioned download. The deb and DMG remain manual installers.

A stable publication sets GitHub's latest release and updates the rolling nightly feed. A nightly publication updates only the nightly feed. The single publisher owns both. A matching retry performs no versioned asset writes and repairs an interrupted feed replacement if needed. Recovery reads the feed from the highest versioned release owned by this workflow, so an older retry cannot restore an older feed after an interrupted replacement. Different bytes for the same feed version fail. The rolling `nightly` release has a workflow ownership marker. A conflicting existing release is refused.

Feed replacement removes the old mutable asset, uploads the new one, and downloads it to verify exact bytes. A crash in that interval can temporarily leave the nightly feed unavailable. Rerun failed jobs to restore it. Empty `starter` assets left by failed GitHub uploads are deleted and retried only in an owned draft or the owned rolling feed. Uploaded versioned assets remain immutable. Versioned downloads and the stable feed remain available. The feed's date and notes derive from the immutable plan, so retries produce the same bytes.

## Resume an interrupted run

Use **Re-run failed jobs** on the original Actions run. Successful plan and build jobs retain their outputs and immutable artifacts. The publisher resumes its exact draft, verifies existing assets byte for byte, uploads only missing assets, and publishes after the complete set verifies. It accepts an already-published matching release, including when the previous runner lost the successful publish response. Conflicting tags, release identities, extra assets, or differing bytes fail without overwriting anything.

**Re-run all jobs** also works while the original artifacts remain available. The planner restores `release-plan/plan.json` before reading release history. It retains the original version and source even across UTC midnight or later publications. Build jobs restore existing `bundles-*` artifacts and skip rebuilding them. Missing artifacts for previously successful build jobs stop recovery. A missing disposable signing-key artifact also stops a PR rerun. Failed builds that never produced an artifact can run again. The final verifier rechecks every restored bundle.

Artifacts have 30-day retention. If a plan, successful build, or disposable signing-key artifact expires or is deleted, this run cannot recover safely. Start a new dispatch after inspecting the existing release and tag. A new dispatch is a new plan, not a retry. A draft with different signed bytes cannot be repaired by overwriting its assets through this workflow. Resolve that draft manually before starting another attempt for the same stable version. Published releases remain immutable. An older stable draft cannot publish after a newer stable version ships. Verifying an older matching published release remains a successful retry.

All non-PR release runs share a workflow-level concurrency group before planning, with `cancel-in-progress: false` and `queue: max`. GitHub allows up to 100 pending runs. PRs use separate cancelable groups with a single pending run. See [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency). Actionlint 1.7.12 predates the `queue` key. For that version, validate with only its unsupported-key diagnostic suppressed:

```sh
actionlint -ignore 'unexpected key "queue" for "concurrency"' .github/workflows/ci.yml .github/workflows/release.yml
```

Build jobs only upload workflow artifacts. The sole publisher has `contents: write` and runs after CI, both builds, and read-only completeness verification. No deployment or version-bump commits are produced. Versioned release assets are immutable. Only the rolling nightly feed asset is replaced.
