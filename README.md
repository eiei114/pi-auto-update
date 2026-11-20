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
- On Windows, defers extension updates when an active Pi runtime may hold package files open.
- Provides `/auto-update-now` for an explicit update check.
- Reports failures in the Pi UI without aborting session startup.

With the verified Pi SDK 1.5.2, `pi --offline` sets `PI_OFFLINE=1` before
loading extensions, so it also skips automatic updates. To disable startup
updates explicitly, set `PI_OFFLINE=1` or `PI_AUTO_UPDATE=0` in Pi's environment.
The manual `/auto-update-now` command still runs when explicitly requested.

## Install

Install the published npm package with Pi:

```bash
pi install npm:pi-auto-update
```

Pin a specific version when you want reproducible installs:

```bash
pi install npm:pi-auto-update@0.1.11
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

On Windows, npm cannot replace an extension package while an active Pi runtime
(including the `pi-intercom` broker) is using files inside that package. When
that runtime is detected, the extension step is deferred and the Pi update
still runs. If npm reports `EBUSY` (`-4082` or `4294963214`), close Pi
runtimes and run `pi update --extensions` from a shell.

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
| `scripts/` | Repository-only helpers: `pi-sdk-smoke.mjs` (installed-Pi smoke), `pi-sdk-smoke-contract.mjs` (smoke expectations), `check-no-npm-token.mjs` (workflow token guard), `release-version-check.mjs` (Auto Release gate), `bench-output-parsing.mjs` (failure-output micro-benchmark) |
| `tests/` | Repository-only `node --test` suites: extension behavior and edge cases, installed-package smoke, Pi SDK smoke contract, release gate, README pin check |

Only the first five paths above are published in the npm tarball; `scripts/` and
`tests/` stay in the repository and are excluded by `files` in `package.json`.

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
shell. It also starts a real Pi process with `--offline`, `PI_OFFLINE` unset,
and `PI_AUTO_UPDATE=1`, requiring the offline skip notification and zero updater
shim invocations. The actual Pi host and extension handler run in isolated Pi/npm
directories; temporary updater shims record both commands and prevent real
package or Pi updates. The error case removes the shims to verify handled
failures. The smoke makes no model requests. CI runs it as part of `npm run ci`.

## Release

This package publishes to npm through GitHub Actions Trusted Publishing, so no
`NPM_TOKEN` is required. Releases are manual and owner-run: merging a pull
request does not publish anything.

1. Update `package.json`, `CHANGELOG.md`, and the `README.md` install pin example
   (`pi install npm:pi-auto-update@<version>`) in the same pull request, then
   merge it to `main`. The pin must match `package.json.version`, because
   `npm test` fails when they disagree. Merging does not start a release. Do not
   run `npm version`: this flow does not use a tag created from a workstation.
2. From the Actions tab, run **Auto Release** manually on the `main` branch. The
   workflow compares `package.json` with the latest reachable `v<version>` tag
   and continues only when the version is newer and its tag does not already
   exist. If it cannot verify the previous tag and its package version, it
   skips the release.
3. On a verified version bump, `auto-release.yml` creates `v<version>` and a
   GitHub Release, then dispatches `publish.yml`, which publishes with
   provenance. Reruns skip versions already present on npm.

See [`docs/release.md`](docs/release.md) for setup details and skip conditions.

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
