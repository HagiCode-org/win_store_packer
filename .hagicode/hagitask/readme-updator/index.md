---
public: true
multilingual: false
style: technical
---

# README requirements

## Audience and focus

- Address maintainers who resolve Desktop, Server and Turbo Engine DLC releases, validate the staged payload and invoke the desktop-owned Microsoft Store packaging entry point.
- Keep the statement that Desktop owns Store packaging and this repository does not build MSIX packages itself.

## Required content

- Keep recent release plans (generated block between the `release-plan-history` markers), responsibilities, configuration, workflow shape, signing, local verification, local commands and artifact layout.
- Do not hand-edit the generated release plan table.

## Exclusions

- Exclude signing certificates, passwords and thumbprints, Store credentials, tokens, internal hosts, machine-specific paths and private links.
