# win_store_packer

`win_store_packer` builds and publishes Windows Store MSIX packages that already contain the bundled Hagicode Server runtime.

It resolves the latest eligible Desktop and Server releases from the Azure index manifests, maps the selected Desktop release to the exact Desktop Git tag, prepares a tagged Desktop source workspace, stages the Server payload into `resources/portable-fixed/current`, builds an unsigned Store package, optionally stages and signs a second MSIX variant for Microsoft Store submission, and publishes the resulting artifacts plus release metadata from this repository.

The published MSIX is intentionally treated as **Steam mode by default**. Desktop switches into `distributionMode=steam` whenever the packaged `extra/portable-fixed/current` payload validates, so this Store flow ships that payload as the authoritative runtime source and records `distributionMode: "steam"` plus `runtimeSource: "portable-fixed"` in the emitted metadata.

## Repository Contract

- `hagicode-desktop` is a read-only input. This repository expects it at `inputs/hagicode-desktop` and tracks it through `.gitmodules`.
- The selected Desktop release version is normalized to the exact Git tag `v<desktop-version-without-leading-v>`.
- The selected Desktop tag is also the source of truth for Store package versioning. Stable tags like `v0.1.56` become the Windows package version `0.1.56.0`.
- Non-stable Desktop tags are rejected for Store packaging because Windows package versions must stay numeric.
- Workspace preparation fails fast if that tag does not exist or cannot be checked out cleanly.
- The final packaged runtime must come from `resources/portable-fixed/current`, which electron-builder already maps to `extra/portable-fixed/current` inside the Store package.
- The packaged `portable-fixed/current` payload is the contract that makes Desktop start in Steam mode for this distribution.

## Configuration

### `config/store-package.json`

Defines the Store package identity metadata and packaging contract:

- `packageIdentity.displayName`
- `packageIdentity.publisherDisplayName`
- `packageIdentity.publisher`
- `packageIdentity.identityName`
- `packageIdentity.backgroundColor`
- `packageIdentity.languages`
- `appx.minVersion`
- `appx.maxVersionTested`
- `packageVersion.source`
- `packageVersion.revision`
- `signing.publisherSubjectEnvVar`
- `signing.verificationScriptRelativePath`
- `signing.azure.*`
- `supportedWindowsTargets`
- `desktop.submodulePath`
- `desktop.electronBuilderConfigPath`
- `desktop.buildScript`
- `desktop.runtimeInjectionPath`

### `config/workflow-defaults.json`

Defines workflow defaults such as:

- default platforms (`win-x64`)
- artifact names
- default Desktop source path
- schedule cadence

## Workflow Inputs

Workflow: `.github/workflows/package-release.yml`

Manual dispatch inputs:

- `desktop_version`: optional Desktop version selector
- `server_version`: optional Server version selector
- `force_rebuild`: bypass duplicate-release detection
- `dry_run`: build and generate publication metadata without writing GitHub Releases

Scheduled runs use the latest eligible Windows Desktop and Server assets from the configured Azure indexes and skip packaging when the derived Store release tag already exists.

## Microsoft Store publication

`package-release.yml` now publishes the built `.msix` variants to Microsoft Store in the same workflow run that publishes the GitHub Release. The Store publish job is skipped when `dry_run` is enabled.

The workflow uses the official `microsoft/store-submission@v1` action instead of invoking the `msstore` CLI directly. It first publishes the `.msix` variants to the GitHub Release, then builds the `product-update` payload from the public release asset URLs and submits only the signed primary package to Partner Center as a packaged app submission.

### Signing requirements

Release-capable CI runs require Azure Artifact Signing and fail before publication if any of these secrets are missing:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_CODESIGN_ENDPOINT`
- `AZURE_CODESIGN_ACCOUNT_NAME`
- `AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME`
- `AZURE_CODESIGN_APPX_PUBLISHER`

`AZURE_CODESIGN_APPX_PUBLISHER` must match the signing certificate subject because the workflow rewrites `appx.publisher` in the Store overlay before packaging.

`dry_run` builds stay unsigned-only on purpose so local and fixture-style verification can run without Azure signing access.

Configure the repository with the Microsoft Store credentials required by `microsoft/store-submission@v1`:

- `SELLER_ID`
- `TENANT_ID` (or the legacy `AZURE_AD_TENANT_ID`)
- `CLIENT_ID` (or the legacy `AZURE_AD_APPLICATION_CLIENT_ID`)
- `CLIENT_SECRET` (or the legacy `AZURE_AD_APPLICATION_SECRET`)

Also configure `MICROSOFT_STORE_PRODUCT_ID` as a repository variable or secret so the workflow can target the correct Partner Center product.

## Local Verification

From `repos/win_store_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
```

## Local Script Entry Points

Resolve a build plan:

```bash
node scripts/resolve-dispatch-build-plan.mjs \
  --event-name workflow_dispatch \
  --desktop-azure-sas-url "<desktop-sas>" \
  --server-azure-sas-url "<server-sas>" \
  --output build/build-plan.json
```

Prepare the Desktop workspace at the selected tag:

```bash
node scripts/prepare-packaging-workspace.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --desktop-source inputs/hagicode-desktop
```

Stage the Server payload:

```bash
node scripts/stage-server-payload.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64
```

Build the MSIX artifact:

```bash
node scripts/build-appx.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64
```

Build with required signing configuration validation:

```bash
AZURE_CLIENT_ID=... \
AZURE_TENANT_ID=... \
AZURE_SUBSCRIPTION_ID=... \
AZURE_CODESIGN_ENDPOINT=... \
AZURE_CODESIGN_ACCOUNT_NAME=... \
AZURE_CODESIGN_CERTIFICATE_PROFILE_NAME=... \
AZURE_CODESIGN_APPX_PUBLISHER="CN=..." \
node scripts/build-appx.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --signing-mode required
```

Dry-run the publication flow:

```bash
node scripts/publish-release.mjs \
  --plan build/build-plan.json \
  --artifacts-dir build/store-win-x64 \
  --output-dir build/release-metadata \
  --force-dry-run
```

## Artifact Layout

Per-platform build outputs are written into the workspace root:

- `workspace-manifest.json`
- `workspace-validation-win-x64.json`
- `payload-validation-win-x64.json`
- `build-metadata-win-x64.json`
- `artifact-inventory-win-x64.json`
- `release-assets/hagicode-store-<release-tag>-win-x64-unsigned.msix`
- `release-assets/hagicode-store-<release-tag>-win-x64-signed.msix` when signing is enabled and finalized

The build metadata and artifact inventory also record:

- `distributionMode: "steam"`
- `runtimeSource: "portable-fixed"`
- `storePackageVersion`
- `variant`, `signed`, and `primaryForStoreSubmission`

Publication outputs are written into the publish output directory:

- `<release-tag>.artifact-inventory.json`
- `<release-tag>.release-metadata.json`
- `<release-tag>.publish-dry-run.json` for dry runs
- `<release-tag>.publication-result.json` for real releases

The release metadata and dry-run report also record:

- `distributionMode: "steam"`
- `runtimeSource: "portable-fixed"`
- `storePackageVersion`

## Signed vs unsigned artifacts

- The unsigned MSIX is always preserved for inspection and troubleshooting.
- The signed MSIX is staged from the unsigned output so both variants come from the same prepared workspace.
- Only the signed artifact is marked `primaryForStoreSubmission: true` and consumed by `build-store-submission-update.mjs`.
- Unsigned-only runs leave `primaryForStoreSubmission` unset and clearly report that no signed Store submission package was produced.

## Store-specific Differences From Desktop CI

- The Store flow preserves Store identity metadata by generating a Store-specific electron-builder config overlay from `config/store-package.json`.
- The workflow runs `azure/login@v2` plus `azure/artifact-signing-action@v1` for release-capable signed publication.
- GitHub Releases receive the MSIX artifact and release metadata JSON; Steam depot data and Azure Steam index updates are out of scope here.
