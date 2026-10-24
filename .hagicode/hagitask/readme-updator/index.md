---
public: true
multilingual: false
style: product
---

# README requirements

## Product focus

- Present `win_store_packer` as the release tool that turns published Desktop, Server and Turbo Engine DLC releases into a Windows (`win-x64`) Microsoft Store package release: it resolves the versions, validates the staged payload, runs the desktop-owned Store packaging entry point and publishes GitHub release assets and metadata.
- Main features users get: a recent release plans table, a consistent Store version derived from the release tag, payload and package validation, and published `.msix` assets with release metadata.
- Address release maintainers; this is internal tooling with no end-user product, so describe what it lets maintainers do.
- Keep the statement that Desktop owns Store packaging and this repository does not build MSIX packages itself.
- Lead with what a maintainer gets from a release run, then how to run it.

## Required content

- Open with a short description of what the tool produces and the Desktop ownership statement.
- Keep the recent release plans block between the `release-plan-history` markers; do not hand-edit the generated table or its markers.
- Summarise what the tool and Desktop each do, and show the local commands a maintainer runs. Commands must match `package.json` and `scripts/`.

## Exclusions

- Exclude signing certificates, passwords and thumbprints, Store credentials, tokens, internal hosts, machine-specific paths and private links.
- Keep repository maintenance instructions out of the README: repository layout, internal architecture, configuration schema details, workflow shape, signing setup, CI, build internals and contribution workflow.
