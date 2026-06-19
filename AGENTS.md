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
```

## Key Paths

- `scripts/`: packaging, publication, and signing scripts
- `tests/`: verification and dry-run tests

## Agent Guidelines

- This repo does NOT render Store overlays or build MSIX packages independently; Desktop owns that responsibility.
- The canonical Microsoft Store version input comes from the packer Release Drafter tag.
- Signing finalization is optional and controlled by configuration.
- Run `npm run verify:signing` after changes to the signing pipeline.

## References

- `README.md`
