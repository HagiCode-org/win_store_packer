# Win Store Packer - Agent Configuration

## Root Configuration

Inherits all behavior from `/AGENTS.md` at the monorepo root. Local rules extend or override the root file for this repository.

## Project Context

`win_store_packer` resolves Desktop, Server, and Turbo Engine DLC releases, validates staged runtime payloads, invokes desktop-owned Microsoft Store packaging, optionally finalizes signing, and publishes GitHub release metadata. Desktop now owns Store packaging; this repo orchestrates the pipeline.

## Working Directory

Run commands from `repos/win_store_packer/`.

## Key Commands

```bash
npm install
npm test
npm run verify:dry-run
npm run verify:publication
npm run verify:signing
npm run test:win-store:local   # Windows-only local MSIX generate/install/launch workflow
```

`test:win-store:local` needs the Desktop checkout at `inputs/hagicode-desktop` (git submodule, see `.gitmodules`) or `--desktop-source <path>`; its workspace defaults to `build/store-win-x64`. See `README.md` for flags.

## Key Paths

- `scripts/`: packaging, publication, and signing scripts
- `tests/`: verification and dry-run tests
- `config/`: `store-package.json`, `workflow-defaults.json`, and `release-plan-history.json` (refreshed by CI, not hand-edited)
- `.github/workflows/`: `package-release.yml` (main pipeline), `release-draft-action.yml` (calls `HagiCode-org/hagi-release-drafter` to refresh the next draft release), `release-plan-preview.yml`, `list-store-apps.yml`

## Agent Guidelines

- This repo does NOT render Store overlays or build MSIX packages independently; Desktop owns that responsibility.
- The canonical Microsoft Store version input comes from the packer draft release tag.
- Server/DLC packaging inputs resolve from public/R2 sources (`asset.directUrl` or public base + `asset.path`); Azure Blob SAS is legacy fallback only. Signing still uses Azure Trusted Signing / OIDC.
- Signing finalization is optional and controlled by configuration.
- Run `npm run verify:signing` after changes to the signing pipeline.

## References

- `README.md`
