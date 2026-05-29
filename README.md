# win_store_packer

`win_store_packer` resolves Desktop and Server releases, validates the Server payload, invokes the desktop-owned Windows Store packaging entrypoint, optionally finalizes signing, and publishes GitHub release metadata.

Desktop now owns Store packaging. This repository does not render Store overlays or build MSIX packages independently anymore.

## Responsibilities

`win_store_packer` keeps these responsibilities:

- resolve Desktop and Server versions from the release indexes
- map the Desktop version to the exact Desktop Git tag
- prepare a tagged Desktop worktree for packaging
- download, extract, and validate the Server payload
- invoke `npm run build:win:store` in the Desktop workspace
- optionally finalize and verify signed artifacts
- publish GitHub release assets and machine-readable release metadata

Desktop owns these responsibilities:

- Store package identity and capability metadata in `config/store-package.json`
- Store overlay generation
- payload injection into the packaged runtime layout
- AppX/MSIX package generation
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

### `config/workflow-defaults.json`

Defines workflow defaults such as:

- default platforms
- build-plan artifact naming
- release-metadata artifact naming
- Desktop source checkout path
- schedule cadence

## Workflow Shape

`.github/workflows/package-release.yml` now follows this flow:

1. resolve a build plan from Desktop and Server indexes
2. prepare a tagged Desktop workspace
3. download and validate the Server payload
4. run `scripts/build-appx.mjs`, which forwards to Desktop `npm run build:win:store`
5. optionally finalize signing for the `signed` variant
6. publish GitHub release assets and release metadata

The workflow no longer replays Desktop packaging internals such as overlay rendering or packer-owned MSIX generation.

## Signing

Two signing modes remain relevant:

- `disabled`: publish the desktop-produced artifact only
- `external`: preserve the Desktop artifact, sign it in workflow post-processing, then finalize metadata

`required` is still supported for script-level validation, but the main workflow uses explicit post-processing with `azure/artifact-signing-action@v2`.

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

Resolve a build plan:

```bash
node scripts/resolve-dispatch-build-plan.mjs \
  --event-name workflow_dispatch \
  --desktop-azure-sas-url "<desktop-sas>" \
  --server-azure-sas-url "<server-sas>" \
  --output build/build-plan.json
```

Prepare the Desktop workspace:

```bash
node scripts/prepare-packaging-workspace.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --desktop-source inputs/hagicode-desktop
```

Download and validate the Server payload:

```bash
node scripts/stage-server-payload.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64
```

Invoke the Desktop Store build contract:

```bash
node scripts/build-appx.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --artifact-variant unsigned
```

Finalize a signed artifact after external signing:

```bash
node scripts/finalize-appx-signing.mjs \
  --workspace build/store-win-x64 \
  --platform win-x64 \
  --artifact-variant signed \
  --require-signed
```

Publish release metadata:

```bash
node scripts/publish-release.mjs \
  --plan build/build-plan.json \
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
- `release-assets/*.appx` or `release-assets/*.msix`

Publication outputs include:

- `<release-tag>.artifact-inventory.json`
- `<release-tag>.release-metadata.json`
- `<release-tag>.publish-dry-run.json`
- `<release-tag>.publication-result.json`

The published release metadata records the Desktop version/tag, Server version, Desktop Store config source, published artifacts, and the submission-ready variant for the workflow run.
