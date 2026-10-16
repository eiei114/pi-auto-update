# Security policy

Report vulnerabilities privately through GitHub Security Advisories for
`eiei114/pi-auto-update`. Do not open public issues for undisclosed vulnerabilities.

## Trust model

This extension installs supported updates only after complete dependency scanning
(where applicable) and a separate tool-less AI review with zero findings.
It does not promise vulnerability-free code and is not an OS sandbox.

Trust is still required in the baseline installation, updater, npm/Git clients,
public package registries, advisory data, and configured model provider. Code is
sent to that provider for review and normal inference charges may apply.
Prompt injection and false-negative reviews remain possible.

No update falls back to an unconditional `pi update` command. Unsupported sources,
Pi core, and project-local packages are deferred. Offline mode applies to manual
commands too. Lifecycle scripts and Git hooks are disabled during staging.

The gate covers only this extension's update path, not initial/missing-package
installation, Pi's own commands, or other updaters. Stop other Pi processes before
restoring backups.
See [README.md](README.md) for scope, recovery and limitations.
