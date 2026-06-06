# win_store_packer

`win_store_packer` resolves Desktop and Server releases, validates the Server payload, invokes the desktop-owned Windows Store packaging entrypoint, optionally finalizes signing, and publishes GitHub release metadata.

Desktop now owns Store packaging. This repository does not render Store overlays or build MSIX packages independently anymore.

## Responsibilities

`win_store_packer` keeps these responsibilities:

- resolve Desktop and Server versions from the release indexes
- resolve the packer Release Drafter tag and use it as the canonical Windows Store version input
- prepare a tagged Desktop worktree for packaging
- download, extract, and validate the Server payload
- invoke `npm run build:win:store` in the Desktop workspace
- optionally finalize and verify signed artifacts
- publish GitHub release assets and machine-readable release metadata

Desktop owns these responsibilities:

- Store package identity and capability metadata in `config/store-package.json`
- Store overlay generation
- Windows Store version metadata injected into Desktop builds
- payload injection into the packaged runtime layout
- MSIX package generation
- desktop-originated build metadata

## Configuration

### `config/store-package.json`

This repository now stores workflow-facing defaults plus the Desktop contract reference:

- `supportedWindowsTargets`
- `packageVersion`
- `signing.*`
- `desktop.submodulePath`
- `desktop.storeConfigPath`
- `desktop.buildCommand`
- `desktop.runtimeInjectionPath`

Store identity fields such as `identityName`, `publisher`, `languages`, and `capabilities` no longer live here. They are loaded from the tagged Desktop repository.

The canonical upstream version input remains `release.canonicalVersionInput`, which must equal the `win_store_packer` Release Drafter tag and is mirrored into `release.windowsStoreVersion` for downstream metadata checks.

### `config/workflow-defaults.json`

Defines workflow defaults such as:

- default platforms
- build-plan artifact naming
- release-metadata artifact naming
- Desktop source checkout path
- schedule cadence

## Workflow Shape

`.github/workflows/package-release.yml` now follows this flow:

1. `sync-version-plan.yml` finds the active Release Drafter draft release
2. `sync-version-plan.yml` resolves Desktop and Server versions and uploads `release-plan.json` to that draft release
3. `package-release.yml` starts only from a published release or a manual rebuild of a published release tag
4. `package-release.yml` downloads and validates `release-plan.json` before any build job starts
5. the workflow prepares a Desktop `main` worktree, downloads the Server payload, and runs `scripts/build-msix.mjs`
6. the existing signing, artifact upload, and release metadata publication steps continue unchanged after plan validation succeeds

The workflow no longer replays Desktop packaging internals such as overlay rendering or packer-owned MSIX generation.

### Manual rebuilds

`workflow_dispatch` on `package-release.yml` now accepts:

- `build_mode`: choose `published-release` to reuse an attached `release-plan.json`, or `main` to build from Desktop `main` plus the latest Server payload for testing
- `release_tag`: the published `win_store_packer` release tag whose attached `release-plan.json` should be reused
- `dry_run`: optional flag to rebuild and restage metadata without mutating the published GitHub Release

When `build_mode=main`, the workflow:

- resolves the current Release Drafter tag
- generates a fresh plan from Desktop `main` and the latest eligible Server build
- performs the normal Desktop Store packaging flow instead of the synthetic dry-run build
- forces artifact-only publication so the resulting MSIX packages and release metadata stay in GitHub Actions artifacts for testing

The workflow no longer accepts `desktop_source=release`, Desktop release selectors, or any branch that derived package inputs from release notes text.

## Signing

Two signing modes remain relevant:

- `disabled`: publish the desktop-produced artifact only
- `external`: preserve the Desktop artifact, sign it in workflow post-processing, then finalize metadata

`required` is still supported for script-level validation, but the main workflow uses explicit post-processing with `azure/artifact-signing-action@v2`.

Signed packaging runs now target the GitHub Actions `production` environment so Azure OIDC login presents the `repo:HagiCode-org/win_store_packer:environment:production` subject expected by federated credentials.

Release metadata now distinguishes:

- the desktop-produced unsigned artifact
- the post-signed artifact when available
- the `submissionReadyVariant` for that workflow run

## Local Verification

From `repos/win_store_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
npm run verify:signing
```

## Local Commands

Generate and upload the draft-attached release plan that `sync-version-plan.yml` manages:

```bash
node scripts/sync-release-plan.mjs \
  --event-name workflow_dispatch \
  --desktop-azure-sas-url "<desktop-sas>" \
  --server-azure-sas-url "<server-sas>" \
  --output build/release-plan.json
```

Download the published release plan locally and validate it:

```bash
node scripts/download-release-plan.mjs \
  --release-tag "v1.4.0" \
  --output build/release-plan.json

node scripts/resolve-release-plan.mjs \
  --plan build/release-plan.json \
  --expected-release-tag "v1.4.0"
```

If you want to generate a local plan without touching GitHub release assets, use the same plan builder that powers the sync workflow:

```bash
node scripts/resolve-dispatch-build-plan.mjs \
  --event-name workflow_dispatch \
  --packer-release-tag "v1.4.0" \
  --producer-workflow sync-version-plan \
  --desktop-azure-sas-url "<desktop-sas>" \
  --server-azure-sas-url "<server-sas>" \
  --output build/release-plan.json
```

Prepare the Desktop workspace:

```bash
node scripts/prepare-packaging-workspace.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --desktop-source inputs/hagicode-desktop
```

Download and validate the Server payload:

```bash
node scripts/stage-server-payload.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64
```

Invoke the Desktop Store build contract:

```bash
node scripts/build-msix.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --artifact-variant unsigned
```

Finalize a signed artifact after external signing:

```bash
node scripts/finalize-msix-signing.mjs \
  --workspace build/store-win-x64 \
  --platform win-x64 \
  --artifact-variant signed \
  --require-signed
```

Publish release metadata:

```bash
node scripts/publish-release.mjs \
  --plan build/release-plan.json \
  --artifacts-dir build/store-win-x64 \
  --output-dir build/release-metadata \
  --force-dry-run
```

## Artifact Layout

Per-workspace outputs include:

- `workspace-manifest.json`
- `workspace-validation-<platform>.json`
- `payload-validation-<platform>.json`
- `reports/desktop-store-build-<platform>-<variant>.json`
- `build-metadata-<platform>-<variant>.json`
- `artifact-inventory-<platform>-<variant>.json`
- `release-assets/*.msix`

Those workspace and publication artifacts now repeat the same three values for verification:

- the canonical `win_store_packer` Release Drafter tag
- the mirrored Windows Store version
- the normalized Windows Store package version

Publication outputs include:

- `<release-tag>.artifact-inventory.json`
- `<release-tag>.release-metadata.json`
- `<release-tag>.publish-dry-run.json`
- `<release-tag>.publication-result.json`

The published release metadata records the Desktop version/tag, Server version, Desktop Store config source, published artifacts, and the submission-ready variant for the workflow run.
