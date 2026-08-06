# win_store_packer

`win_store_packer` resolves Desktop, Server, and Turbo Engine DLC releases, validates the staged runtime payload, invokes the desktop-owned Microsoft Store packaging entrypoint, and publishes GitHub release metadata.

Desktop now owns Store packaging. This repository does not render Store overlays or build MSIX packages independently anymore.

## Responsibilities

`win_store_packer` keeps these responsibilities:

- resolve Desktop, Server, and Turbo Engine DLC versions from the release indexes
- resolve the packer Release Drafter tag and derive the canonical Microsoft Store version from it
- prepare a tagged Desktop worktree for packaging
- download, extract, and validate the Server payload plus the required Turbo Engine DLC package
- invoke `npm run build:win:store` in the Desktop workspace
- publish GitHub release assets and machine-readable release metadata

Desktop owns these responsibilities:

- Store package identity and capability metadata in `config/store-package.json`
- Store overlay generation
- Microsoft Store version metadata injected into Desktop builds
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
- `dlcs.turbo-engine.*`

The `dlcs.turbo-engine` block defines the required Store-bundled DLC contract:

- `dlcId`: canonical runtime DLC identifier (`pcode.turbo-engine`)
- `directoryId`: staged runtime directory name (`turbo-engine`)
- `sourceName`: DLC root-index entry used during plan resolution
- `runtimeTargetPath`: merged runtime destination (`lib/dlcs/turbo-engine`)
- `runtimeIndexPath`: regenerated root catalog path (`lib/dlcs/index.json`)
- `manifestFileName` / `filesManifestFileName`: required structured DLC files

Store identity fields such as `identityName`, `publisher`, `languages`, and `capabilities` no longer live here. They are loaded from the tagged Desktop repository.

Desktop capability validation continues to normalize `runFullTrust`, but it does not require or reintroduce `unvirtualizedResources` when the Desktop Store config omits that legacy flag.

The canonical Microsoft Store version is always derived from the authoritative release tag and is never stored in the producer plan. The producer omits `release.canonicalVersionInput`, `release.windowsStoreVersion`, and `release.versionSource`; `validateReleasePlan` recomputes them from the release tag (`release.tag`) and injects them back into the resolved plan as `release.canonicalVersionInput`, `release.windowsStoreVersion`, and `release.versionSource` for downstream metadata checks.

For main test builds that are not bound to a release tag, the canonical version is reported as the fixed sentinel `0.1.0` (`DESKTOP_MAIN_BUILD_VERSION`) regardless of the packer Release Drafter placeholder tag. Tagged releases compute the canonical version directly from the tag as the single source of truth.

### `config/workflow-defaults.json`

Defines workflow defaults such as:

- default platforms
- build-plan artifact naming
- release-metadata artifact naming
- Desktop source checkout path
- schedule cadence

## Workflow Shape

`.github/workflows/package-release.yml` follows this flow:

1. `package-release.yml` starts from a published release or a manual rebuild of a published release tag
2. `package-release.yml` generates a fresh `release-plan.json` from the authoritative release tag plus the latest Desktop/Server index state; Turbo Engine DLC artifact paths are derived from the selected Server version
3. the workflow prepares a Desktop `main` worktree, downloads the Server payload, merges the Turbo Engine DLC runtime under `lib/dlcs/turbo-engine`, regenerates `lib/dlcs/index.json`, and runs `scripts/build-msix.mjs`
4. the workflow builds the unsigned Desktop Store package, uploads its artifacts, and publishes release metadata after plan validation succeeds

The release plan is no longer pre-synced to a draft release asset. The canonical Microsoft Store version is always derived from the release tag at consume time, so the plan is generated on demand inside `package-release.yml`.

The workflow no longer replays Desktop packaging internals such as overlay rendering or packer-owned MSIX generation.

### Manual rebuilds

`workflow_dispatch` on `package-release.yml` accepts:

- `build_mode`: choose `published-release` to publish to a released tag, or `main` to build from Desktop `main` plus the latest Server payload for testing
- `release_tag`: the published `win_store_packer` release tag to rebuild and publish against (used only when `build_mode=published-release`)
- `dry_run`: optional flag to build and stage release metadata without mutating the published GitHub Release

When `build_mode=main`, the workflow:

- resolves the current Release Drafter tag
- generates a fresh plan from Desktop `main` and the latest eligible Server build
- performs the normal Desktop Store packaging flow instead of the synthetic dry-run build
- forces artifact-only publication so the resulting MSIX packages and release metadata stay in GitHub Actions artifacts for testing

The workflow no longer accepts `desktop_source=release`, Desktop release selectors, or any branch that derived package inputs from release notes text.

## Signing

Azure Trusted Signing is temporarily suspended. The release workflow builds and publishes only the Desktop-produced unsigned Store package; it does not request Azure credentials, authenticate with Azure OIDC, or produce a signed artifact.

## Local Verification

From `repos/win_store_packer`:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
```

## Local Commands

Artifact downloads default to Cloudflare public sources from the release plan (public base + `asset.path`, then `asset.directUrl` or the official `downloadSources` entry). Server artifacts use `https://dl-server.hagicode.com`; Turbo Engine DLC artifacts use `https://dl-dlc.hagicode.com`. When an external DLC `index.json` is supplied, the packer reads the current `dlcs[].versions[].artifacts[]` shape and preserves its structured download metadata.
Set `WIN_STORE_PACKER_SERVER_PUBLIC_BASE_URL` / `WIN_STORE_PACKER_DLC_PUBLIC_BASE_URL` or pass `--public-base-url` / `--dlc-public-base-url` to override the Cloudflare public bases.

Generate a release plan locally from an authoritative tag, exactly like `package-release.yml` does at consume time:

```bash
node scripts/resolve-dispatch-build-plan.mjs \
  --event-name workflow_dispatch \
  --packer-release-tag "v1.4.0" \
  --producer-workflow package-release \
  --output build/release-plan.json
```

Validate the generated plan against the expected release tag:

```bash
node scripts/resolve-release-plan.mjs \
  --plan build/release-plan.json \
  --expected-release-tag "v1.4.0"
```

Prepare the Desktop workspace:

```bash
node scripts/prepare-packaging-workspace.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --desktop-source inputs/hagicode-desktop
```

Download, validate, and merge the Server payload plus Turbo Engine DLC.
Prefer plan `directUrl` / public base; optional local overrides still work:

```bash
node scripts/stage-server-payload.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --public-base-url "https://dl-server.hagicode.com" \
  --dlc-public-base-url "https://dl-dlc.hagicode.com" \
  --dlc-asset-source "<optional-local-turbo-engine-archive>"
```

Environment alternatives: `WIN_STORE_PACKER_SERVER_PUBLIC_BASE_URL` (defaults to `https://dl-server.hagicode.com`) and `WIN_STORE_PACKER_DLC_PUBLIC_BASE_URL` (defaults to `https://dl-dlc.hagicode.com`).
Deprecated fallback: `--azure-sas-url` / `*_AZURE_SAS_URL`.

Invoke the Desktop Store build contract:

```bash
node scripts/build-msix.mjs \
  --plan build/release-plan.json \
  --platform win-x64 \
  --workspace build/store-win-x64 \
  --artifact-variant unsigned
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

The staged payload now records bundled DLC details in `payload-validation-<platform>.json`, and the same `includedDlcs` metadata is copied into `build-metadata-*` plus `artifact-inventory-*` so CI can verify Turbo Engine inclusion without unpacking the MSIX.

Those workspace and publication artifacts now repeat the same three values for verification:

- the canonical `win_store_packer` Release Drafter tag
- the mirrored Microsoft Store version
- the normalized Microsoft Store package version

Publication outputs include:

- `<release-tag>.artifact-inventory.json`
- `<release-tag>.release-metadata.json`
- `<release-tag>.publish-dry-run.json`
- `<release-tag>.publication-result.json`

The published release metadata records the Desktop version/tag, Server version, Desktop Store config source, published artifacts, and the submission-ready variant for the workflow run.
