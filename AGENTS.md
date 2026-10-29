# Win Store Packer - Agent Configuration

## Root Configuration

Inherits all behavior from `/AGENTS.md` at the monorepo root. Local rules extend or override the root file for this repository.

## Project Context

`win_store_packer` resolves Desktop, Server, and Turbo Engine DLC releases, validates staged runtime payloads, invokes desktop-owned Microsoft Store packaging, optionally finalizes signing, and publishes GitHub release metadata. Desktop now owns Store packaging; this repo orchestrates the pipeline.

## Working Directory

Run commands from `repos/win_store_packer/`.

## Key Commands

```bash
pnpm install
pnpm test
pnpm run verify:dry-run
pnpm run verify:publication
pnpm run verify:signing
pnpm run test:win-store:local   # Windows-only local MSIX generate/install/launch workflow
```

`test:win-store:local` needs the Desktop checkout at `inputs/hagicode-desktop` (git submodule, see `.gitmodules`) or `--desktop-source <path>`; its workspace defaults to `build/store-win-x64`. See `README.md` for flags.

## Key Paths

- `scripts/`: packaging, publication, and signing scripts; shared helpers live in `scripts/lib/`
- `tests/`: verification and dry-run tests
- `config/`: `store-package.json`, `workflow-defaults.json`, and `release-plan-history.json` (refreshed by CI, not hand-edited)
- `.github/workflows/`: `package-release.yml` (main pipeline), `release-draft-action.yml` (calls `HagiCode-org/hagi-release-drafter` to refresh the next draft release), `release-plan-preview.yml`, `list-store-apps.yml`

## Agent Guidelines

- This repo does NOT render Store overlays or build MSIX packages independently; Desktop owns that responsibility.
- The canonical Microsoft Store version input comes from the packer draft release tag.
- Server/DLC packaging inputs resolve from public/R2 sources (`asset.directUrl` or public base + `asset.path`); Azure Blob SAS is legacy fallback only. Signing still uses Azure Trusted Signing / OIDC.
- Signing finalization is optional and controlled by configuration.
- Run `pnpm run verify:signing` after changes to the signing pipeline.

## References

- `README.md`

## Package management

- The repository uses pnpm, pinned in `package.json` `packageManager`. Run `corepack enable` once, then `pnpm install`. `pnpm-lock.yaml` is the only lockfile; do not commit `package-lock.json`.
- Settings live in `pnpm-workspace.yaml`. `allowBuilds` lists the dependencies whose install scripts may run (reviewed individually, `false` means reviewed and denied); review any new dependency that has an install script and add it there.
- A local registry mirror belongs in `~/.npmrc` only. Never commit a `registry=` line or a mirror URL; `pnpm run check:registry` (also run in CI) fails on any non-`registry.npmjs.org` `tarball` in the lockfile and on mirror hosts in tracked files.
- Undeclared imports fail under pnpm's strict layout: declare the package instead of hoisting it.
