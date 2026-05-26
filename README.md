# win_store_packer

`win_store_packer` builds and publishes Windows Store MSIX packages that already contain the bundled Hagicode Server runtime.

It resolves the latest eligible Desktop and Server releases from the Azure index manifests, maps the selected Desktop release to the exact Desktop Git tag, prepares tagged Desktop source workspaces, stages the Server payload into `resources/portable-fixed/current`, builds unsigned and signed MSIX variants in parallel, stores them as workflow artifacts, then publishes the GitHub Release assets and release metadata from a separate job.

The published MSIX package is intentionally treated as **Steam mode by default**. Desktop switches into `distributionMode=steam` whenever the packaged `extra/portable-fixed/current` payload validates, so this Store flow ships that payload as the authoritative runtime source and records `distributionMode: "steam"` plus `runtimeSource: "portable-fixed"` in the emitted metadata.

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
- `appx.capabilities`
- `packageVersion.source`
- `packageVersion.revision`
- `signing.publisherSubject`
- `signing.verificationScriptRelativePath`
- `signing.azure.*`
- `supportedWindowsTargets`
- `desktop.submodulePath`
- `desktop.electronBuilderConfigPath`
- `desktop.runtimeInjectionPath`

The packer targets the current Desktop Windows packaging pipeline directly. It prepares runtime resources, runs Desktop production build steps, then invokes `scripts/run-electron-builder.js --win dir --config electron-builder.store.<variant>.yml`, followed by `scripts/package-store-msix.mjs`, inside the tagged Desktop workspace.

### AppX capability contract

The Store overlay must preserve the Windows capability declarations required by Hagicode Desktop runtime behavior.

- `runFullTrust`: required for the Electron desktop process.
- `internetClient`: required for outbound HTTP/HTTPS access such as Hagicode package indices, runtime downloads, GitHub release assets, Azure-hosted metadata, and RSS feeds.
- `internetClientServer`: required for torrent-first sharing acceleration because the packaged client can initiate and accept peer traffic while distributing package payloads.
- `privateNetworkClientServer`: required because Desktop manages the bundled web service over loopback and also supports binding to private-network addresses such as `0.0.0.0` for LAN access.

These capabilities are sourced from `config/store-package.json` and rendered into the generated `electron-builder.store.<variant>.yml` overlay before the Desktop MSIX build runs.

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

## Release Publication

`package-release.yml` now follows the Desktop CI shape more closely:

- resolve the build plan
- build `unsigned` and `signed` MSIX variants as workflow artifacts
- publish GitHub Release assets and release metadata in a separate job

The Microsoft Store automatic submission path is temporarily removed from the main workflow. This repository currently stops at `artifacts` plus `release` publication.

### Signed vs unsigned MSIX variants

- The unsigned MSIX package is always preserved for inspection and troubleshooting.
- The signed MSIX package is built as an independent variant.
- The unsigned MSIX package is always marked `primaryForStoreSubmission: true` in metadata so the later Store handoff can still identify the canonical submission artifact.
- The signed MSIX package is preserved as an additional sideloading package and is not used by the current workflow for Store submission.

### Signing modes

`win_store_packer` supports two signed-package paths:

- Current CI path: the signed workflow variant is built in `external` mode, then the workflow signs the produced `.msix` with `azure/artifact-signing-action@v2`.
- Script-level inline path: `scripts/build-appx.mjs --signing-mode required` still supports rendering Azure Trusted Signing options into `win.azureSignOptions` when a direct Desktop-side signing build is needed.

The current workflow intentionally follows the Desktop repository emphasis on explicit Windows signing orchestration, while still keeping Store-specific payload injection unchanged.

## Local Verification

From `repos/win_store_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
npm run verify:signing
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

Build the unsigned MSIX artifact:

```bash
node scripts/build-appx.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64-unsigned \
  --artifact-variant unsigned
```

Build the signed MSIX variant:

```bash
AZURE_CLIENT_ID=... \
AZURE_TENANT_ID=... \
AZURE_CLIENT_SECRET=... \
node scripts/build-appx.mjs \
  --plan build/build-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64-signed \
  --artifact-variant signed \
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
- `build-metadata-win-x64-unsigned.json`
- `artifact-inventory-win-x64-unsigned.json`
- `build-metadata-win-x64-signed.json`
- `artifact-inventory-win-x64-signed.json`
- `release-assets/hagicode-store-<release-tag>-win-x64-unsigned.msix`
- `release-assets/hagicode-store-<release-tag>-win-x64-signed.msix`

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

## Store-specific Differences From Desktop CI

- The Store flow preserves Store identity metadata by generating a Store-specific electron-builder config overlay from `config/store-package.json`.
- The workflow now treats MSIX release publication as the terminal step; Partner Center submission is intentionally out of band for now.
- GitHub Releases receive the MSIX artifacts and release metadata JSON; Steam depot data and Azure Steam index updates are out of scope here.
