# win_store_packer

[![Release plan preview](https://github.com/HagiCode-org/win_store_packer/actions/workflows/release-plan-preview.yml/badge.svg)](https://github.com/HagiCode-org/win_store_packer/actions/workflows/release-plan-preview.yml)
[![Package release](https://github.com/HagiCode-org/win_store_packer/actions/workflows/package-release.yml/badge.svg)](https://github.com/HagiCode-org/win_store_packer/actions/workflows/package-release.yml)

`win_store_packer` resolves Desktop, Server, and Turbo Engine DLC releases, validates the staged runtime payload, invokes the desktop-owned Microsoft Store packaging entrypoint, and publishes GitHub release metadata.

Desktop now owns Store packaging. This repository does not render Store overlays or build MSIX packages independently anymore.

## Recent release plans

The latest 10 changed versions appear below; older records remain in [`config/release-plan-history.json`](config/release-plan-history.json). Each record stores only the normalized packer tag, status, UTC last-change timestamp, Store version, Desktop version and checkout ref, Server version, Turbo Engine DLC version, and platforms. `Unpublished` is a validated scheduled or manually refreshed preview; `Published` means the real release publication succeeded and uses its release-time plan. Snapshot times indicate when recorded inputs last changed, not when they were last checked. Previews are advisory: release-time plans are authoritative.

<!-- release-plan-history:start -->
| Version | Status | Store version | Desktop / ref | Server | Turbo Engine DLC | Platforms | Snapshot UTC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v0.5.7 | Unpublished | v0.5.7 | v0.4.0 / main | 0.1.0-beta.103 | 0.1.0-beta.103 | win-x64 | 2026-10-24T05:56:42.815Z |
| v0.5.6 | Published | v0.5.6 | v0.4.0 / main | 0.1.0-beta.102 | 0.1.0-beta.102 | win-x64 | 2026-10-23T18:08:51.644Z |
| v0.5.5 | Published | v0.5.5 | v0.3.0 / main | 0.1.0-beta.101 | 0.1.0-beta.101 | win-x64 | 2026-10-22T22:07:58.556Z |
| v0.5.4 | Published | v0.5.4 | v0.2.0 / main | 0.1.0-beta.100 | 0.1.0-beta.100 | win-x64 | 2026-10-20T20:35:38.003Z |
| v0.5.3 | Published | v0.5.3 | v0.2.0 / main | 0.1.0-beta.100 | 0.1.0-beta.100 | win-x64 | 2026-10-20T19:56:51.495Z |
| v0.5.2 | Published | v0.5.2 | v0.2.0 / main | 0.1.0-beta.99 | 0.1.0-beta.99 | win-x64 | 2026-10-20T03:38:06.306Z |
| v0.5.1 | Published | v0.5.1 | v0.1.91 / main | 0.1.0-beta.96 | 0.1.0-beta.96 | win-x64 | 2026-10-15T05:32:08.680Z |
| v0.5.0 | Published | v0.5.0 | v0.1.90 / main | 0.1.0-beta.94 | 0.1.0-beta.94 | win-x64 | 2026-10-11T07:56:25.246Z |
| v0.4.10 | Unpublished | v0.4.10 | v0.1.90 / main | 0.1.0-beta.94 | 0.1.0-beta.94 | win-x64 | 2026-10-11T07:55:09.592Z |
| v0.4.9 | Published | v0.4.9 | v0.1.89 / main | 0.1.0-beta.91 | 0.1.0-beta.91 | win-x64 | 2026-10-09T06:43:51.020Z |
<!-- release-plan-history:end -->

## Responsibilities

`win_store_packer` keeps these responsibilities:

- resolve Desktop, Server, and Turbo Engine DLC versions from the release indexes
- resolve the packer draft release tag and derive the canonical Microsoft Store version from it
- prepare a tagged Desktop worktree for packaging
- download, extract, and validate the Server payload plus the required Turbo Engine DLC package
- invoke `npm run build:win:store` in the Desktop workspace
- validate Desktop build metadata, Store package artifacts, and the staged Server/DLC payload
- publish GitHub release assets and machine-readable release metadata

Desktop owns these responsibilities:

- Store package identity and capability metadata in `config/store-package.json`
- Store overlay generation
- Microsoft Store version metadata injected into Desktop builds
- payload injection into the packaged runtime layout
- MSIX package generation
- desktop-originated build metadata
- validating the packaged .NET runtime and rejecting Desktop-managed Node/PM2 assets

Synthetic dry-run archives do not validate executable MSIX contents. Real Desktop Store builds
validate the packaged .NET runtime and reject Desktop-managed Node/PM2 assets before the packer
accepts their artifacts.

## Local Verification

From the repository root:

```bash
npm test
npm run verify:dry-run
npm run verify:publication
```

### Local Windows Store package test

`npm run test:win-store:local` is the single local workflow for generating,
installing, and launching the Packer-produced MSIX. It must run on Windows with
PowerShell, Node/npm, the Windows AppX/MSIX tooling, and the certificate and
trust prerequisites required by the Desktop Store package. The Desktop source
checkout must be initialized at `inputs/hagicode-desktop`, or supplied with
`--desktop-source`.

The default workspace is `build/store-win-x64`. It contains the release plan,
the isolated Desktop worktree, downloaded and extracted payloads, validation
reports, build metadata, the artifact inventory, and `release-assets/*.msix`.
The command stages the Server and Turbo Engine payload before invoking the
Desktop-owned `build:win:store` contract, validates the generated MSIX contents,
installs that final package for the current user, and launches its installed
application identity. It does not register or launch an unpacked Desktop
development layout.

Basic usage:

```bash
npm run test:win-store:local
```

The local workflow uses the fixed Packer test tag `v0.1.0` by default and
resolves the latest indexed Server release for each newly generated plan. Use
`--packer-release-tag=<tag>` or `WIN_STORE_PACKER_RELEASE_TAG` only when a
different package version is required.

Use an existing plan and local archives when network downloads are not desired:

```bash
npm run test:win-store:local -- \
  --plan build/release-plan.json \
  --desktop-source inputs/hagicode-desktop \
  --server-asset-source C:\archives\server.zip \
  --dlc-asset-source C:\archives\turbo-engine.zip
```

Supported controls include `--platform`, `--workspace`, `--packer-release-tag`,
`--public-base-url`, `--dlc-public-base-url`, `--skip-build`,
`--purchase-smoke-test`, and `--force-renderer-accessibility`. `--skip-build`
requires an existing Packer workspace with a successful payload report and
unsigned MSIX artifact, then performs the content validation, package removal,
installation, and launch stages only. Equivalent environment fallbacks are
available through the `WIN_STORE_PACKER_*` variables documented by `--help`.

Failures are intentional boundaries: invalid plans stop before workspace
mutation, stage failures stop before installation, missing runtime or Server
payload entries stop before installation, and certificate or package-trust
errors from `Add-AppxPackage` are reported instead of falling back to an
unpacked executable or development registration.

## Local Commands

Version resolution defaults to ordered Cloudflare `index.json` endpoints instead of the `index.hagicode.com` portal: Desktop tries `https://dl-desktop.hagicode.com/index.json`, then `https://desktop.dl.hagicode.com/index.json`; Server tries `https://dl-server.hagicode.com/index.json`, then `https://server.dl.hagicode.com/index.json`. Each default request uses a unique query parameter to bypass CDN caches and has a 10-second timeout. The second address is requested only when the first cannot return readable JSON, not when a requested version or asset is absent. An explicit index URL takes precedence over a legacy Azure SAS index source; either override is a single-source choice with no fallback to public defaults. The release plan records the original address that supplied each index, without the cache-busting parameter. Artifact downloads default to Cloudflare public sources from the release plan (public base + `asset.path`, then `asset.directUrl` or the official `downloadSources` entry). Server artifacts use `https://dl-server.hagicode.com`; Turbo Engine DLC artifacts use `https://dl-dlc.hagicode.com`. When an external DLC `index.json` is supplied, the packer reads the current `dlcs[].versions[].artifacts[]` shape and preserves its structured download metadata.
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

## Published release outputs

Publication outputs include:

- `<release-tag>.artifact-inventory.json`
- `<release-tag>.release-metadata.json`
- `<release-tag>.publish-dry-run.json`
- `<release-tag>.publication-result.json`

The published release metadata records the Desktop version/tag, Server version, Desktop Store config source, published artifacts, and the submission-ready variant for the workflow run.