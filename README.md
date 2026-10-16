# Pi Auto Update

[![Join dotfield.xyz on Discord](https://img.shields.io/badge/Join%20dotfield.xyz%20on%20Discord-5865F2?logo=discord&logoColor=white)](https://discord.gg/4945dXZVW5)

[![CI](https://github.com/eiei114/pi-auto-update/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-auto-update/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-auto-update/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-auto-update/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-auto-update.svg)](https://www.npmjs.com/package/pi-auto-update)
[![npm downloads](https://img.shields.io/npm/dm/pi-auto-update.svg)](https://www.npmjs.com/package/pi-auto-update)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple.svg)](https://pi.dev/packages)
[![Trusted Publishing](https://img.shields.io/badge/npm-Trusted%20Publishing-blue.svg)](docs/release.md)
<a href="https://buymeacoffee.com/ekawano114m"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60"></a>

> Review supported Pi package updates before installing them automatically at process startup.

## What this is

Pi Auto Update stages supported personal package updates, scans their dependencies, and asks an independent, tool-less AI reviewer to compare complete old/new changed files. It installs the exact reviewed files only after a complete approval with zero findings. AI review and advisory scans can miss vulnerabilities; approval is not proof of safety.

## Features

- Script-free staging, integrity-pinned dependencies, and `npm audit` before AI review.
- Complete changed-file review, including transitive dependencies, with no model tools or parent conversation history. Large updates use lossless, coverage-checked batches plus a final cross-batch review.
- Configurable review model via `autoUpdate.reviewModel` or `/auto-update-model`, using existing Pi credentials, including Codex OAuth.
- Fail-closed checks: findings, incomplete reviews, scan failures, oversized changes, and tampering block updates; no unchecked updater fallback.
- Exact reviewed-file promotion, retained backups, and JSON review reports.
- Automatically runs once per Pi process, silently in the background without delaying startup or showing footer status/notifications; not again after `/reload`, `/new`, `/resume`, or `/fork`.
- `PI_AUTO_UPDATE=0` disables startup checks; `PI_OFFLINE=1` blocks automatic and manual network updates.
- Provides `/auto-update-now` for an explicit check with result/failure feedback, joining any check already running. Automatic results and failures are recorded without UI messages.

**Scope change:** personal managed npm and clean, unpinned GitHub packages on macOS/Linux only. Pi-core, project-local, Windows, custom package managers, private registries, and unsupported sources are deferred. Configured versions/refs are not advanced. Git runtime dependencies require a complete npm lockfile; dirty checkouts, custom attributes, symlinks/submodules, and bundled/workspace dependencies require manual handling. See [execution details and limits](docs/how-it-works.md).

## Install

Install the published npm package with Pi:

```bash
pi install npm:pi-auto-update
```

Pin a specific version when you want reproducible installs:

```bash
pi install npm:pi-auto-update@0.1.4
```

Install into the current project instead of your user Pi settings:

```bash
pi install npm:pi-auto-update -l
```

Or install from GitHub:

```bash
pi install git:github.com/eiei114/pi-auto-update
```

Try it without permanently installing:

```bash
pi -e npm:pi-auto-update
```

## Quick start

After installation, restart Pi. Startup checks run silently in the background: they stage supported targets, audit dependencies, review complete changes, and promote only approved files. You can use Pi immediately. Check saved reports or run `/auto-update-now` for feedback. Restart Pi after an approved update to load the new code.

Run the same security-gated check manually at any time:

```txt
/auto-update-now
```

An authenticated review model is required when changes need review. Package source is sent to that model's configured provider and consumes its normal quota/cost. No package scripts, builds, tests, or candidate extensions are executed during staging. Each request stays within 180,000 UTF-8 bytes and the selected model's conservative context budget. Larger updates are segmented without dropping text, including large files and unchanged candidate manifests. Every source batch and a final integration review must approve before any installation; batch errors/findings block the entire target. Reviews are bounded to 32 source batches plus one integration request and 15 minutes overall; excessive volume or insufficient context still requires manual handling.

Try the local checkout without permanently installing it:

```bash
pi -e .
```

## Review model settings

The default reviewer follows the current session model. Select a separate model without changing your normal chat model:

```text
/auto-update-model openai-codex/gpt-6-luna
```

`/auto-update-model` shows the selection; `/auto-update-model current` resets it. Alternatively, merge this into your personal `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`):

```json
{
  "autoUpdate": {
    "reviewModel": "openai-codex/gpt-6-luna"
  }
}
```

Use an exact `provider/model` ID authenticated through Pi. Unknown or unauthenticated models block reviews, never silently fall back. Project settings cannot select the reviewer. Codex subscriptions use the `openai-codex` provider; no separate API key is needed. For SDK embeddings, set `PI_CODING_AGENT_DIR` to the SDK agent directory explicitly.

## Package contents

| Path | Purpose |
|---|---|
| `extensions/auto-update.ts` | Startup hook, `/auto-update-now`, and `/auto-update-model` |
| `extensions/security/` | Staging, auditing, model configuration/review, snapshots, and promotion |
| `docs/how-it-works.md` | Execution diagrams, scope, and security limitations |
| `docs/release.md` | Trusted Publishing and release flow |
| `README.md` | GitHub and npm package entrypoint |
| `CHANGELOG.md` | Versioned release notes |
| `LICENSE` | MIT license |

## Development

```bash
npm install
npm run ci
npm run smoke:pi
npm pack --dry-run
PI_AUTO_UPDATE=0 pi -e .
```

Run only the installed-package smoke when changing package metadata or startup
loading behavior:

```bash
npm run test:installed-smoke
```

The installed-package smoke test packs the local package, installs the tarball
into a temporary Pi agent directory, and checks package loading with
`PI_OFFLINE=1`.

`npm run smoke:pi` separately launches the locally pinned Pi CLI in RPC mode,
loads the packed extension, runs its manual update command, verifies handled
failures and a second-process restart/cleanup, and exercises the native host
shell. The actual Pi host and extension handler run in isolated Pi/npm
directories; temporary updater shims verify that no unconditional updater runs.
The error case verifies that manual checks cannot bypass offline mode. The smoke
makes no model requests. CI runs it as part of `npm run ci`. `npm run test:network`
optionally exercises real public-registry resolution/install/audit with a scripted
reviewer, without changing installed packages or testing a live model's judgment.

A reproducible, read-only proof can stage/audit real installed updates and verify full coverage without installing them:

```bash
node scripts/verify-bounded-review.mjs --agent-dir "$HOME/.pi/agent" --output /tmp/bounded-proof.json
```

This uses scripted approvals to test the mechanism. To explicitly opt into real inference, also pass `--sdk /absolute/path/to/pi/dist/index.js --model openai-codex/gpt-6-luna`. Source is sent to that model and consumes quota. The proof never promotes files; its report distinguishes scripted and live results. Add `--fixture` for a benign oversized manifest-only test instead of actual package updates. Regression tests also prove that a late finding, replayed approval, cancellation, or final-review rejection cannot partially install an update.

## Release

This package is set up for npm Trusted Publishing, so no `NPM_TOKEN` is required.

```bash
npm version patch
git push
```

See [`docs/release.md`](docs/release.md) for setup details.

## Docs

- [`docs/release.md`](docs/release.md) — Trusted Publishing and automated release details
- [`ROADMAP.md`](ROADMAP.md) — current status and planned work

## Security

Installing this package opts supported personal packages into automatic security-reviewed updates. This is not an OS sandbox or a vulnerability-free guarantee. The baseline, updater, npm/Git clients, advisory service, and selected model provider remain trusted. Prompt injection and false-negative reviews remain possible; unchanged code is not comprehensively audited.

Reports live under `<agent-dir>/auto-update-security/reports/`; retained backups and promotion journals live under each run directory. Promotion uses two renames with rollback on failure, so a crash can leave the installed path missing: stop Pi and restore from the journal/backup before restarting. Verify the recorded PID is no longer running before removing a stale `<agent-dir>/.auto-update-security.lock`.

The gate covers only this extension's update path, not initial/missing-package installation, manual Pi commands, or other updaters. Pi packages execute with your local permissions. For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).

## Links

- npm: https://www.npmjs.com/package/pi-auto-update
- GitHub: https://github.com/eiei114/pi-auto-update
- Issues: https://github.com/eiei114/pi-auto-update/issues

## License

MIT
