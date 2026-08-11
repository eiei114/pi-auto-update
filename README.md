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

> Keep installed Pi packages and Pi itself current automatically at process startup.

## What this is

Pi Auto Update is a TypeScript Pi package that runs Pi's own update commands once when a new Pi process starts. It updates installed package extensions first, then checks Pi itself, without replacing Pi's built-in updater.

## Features

- Runs `pi update --extensions` before `pi update`.
- Waits for each update step to finish before starting the next one.
- Automatically runs once per Pi process, not again after `/reload`, `/new`, `/resume`, or `/fork`.
- Skips automatic updates when `PI_OFFLINE=1` or `PI_AUTO_UPDATE=0`.
- Provides `/auto-update-now` for an explicit update check.
- Reports failures in the Pi UI without aborting session startup.

## Install

Install the published npm package with Pi:

```bash
pi install npm:pi-auto-update
```

Pin a specific version when you want reproducible installs:

```bash
pi install npm:pi-auto-update@0.1.1
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

After installation, restart Pi. On process startup, Pi Auto Update runs:

```bash
pi update --extensions
pi update
```

Run both checks manually at any time:

```txt
/auto-update-now
```

Try the local checkout without permanently installing it:

```bash
pi -e .
```

## Package contents

| Path | Purpose |
|---|---|
| `extensions/auto-update.ts` | Startup update hook and `/auto-update-now` command |
| `docs/release.md` | Trusted Publishing and release flow |
| `README.md` | GitHub and npm package entrypoint |
| `CHANGELOG.md` | Versioned release notes |
| `LICENSE` | MIT license |

## Development

```bash
npm install
npm run ci
npm pack --dry-run
PI_AUTO_UPDATE=0 pi -e .
```

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

Installing this package opts the machine into automatic code updates from Pi and every package source configured in Pi. Review and trust those sources before installing this extension.

Pi packages can execute code with your local permissions. For vulnerability reporting, see [`SECURITY.md`](SECURITY.md).

## Links

- npm: https://www.npmjs.com/package/pi-auto-update
- GitHub: https://github.com/eiei114/pi-auto-update
- Issues: https://github.com/eiei114/pi-auto-update/issues

## License

MIT
