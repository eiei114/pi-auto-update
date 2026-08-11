# pi-auto-update

[![CI](https://github.com/eiei114/pi-auto-update/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-auto-update/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-auto-update.svg)](https://www.npmjs.com/package/pi-auto-update)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Keep Pi and installed Pi packages current automatically.

On each new Pi process, this extension runs these commands in order and waits for both checks to finish:

```bash
pi update --extensions
pi update
```

Failures are reported in the Pi UI but do not prevent the session from starting.

## Install

```bash
pi install npm:pi-auto-update
```

Restart Pi after installation.

## Behavior

- Runs once for `session_start` with reason `startup`.
- Does not rerun for `/reload`, `/new`, `/resume`, or `/fork`.
- Skips network updates when Pi starts with `--offline` or `PI_OFFLINE=1`.
- Set `PI_AUTO_UPDATE=0` to disable automatic startup updates temporarily.
- Runs each command with a 15-minute timeout.
- Shows progress in the footer and a completion or failure notification.

## Manual update

Run the same sequence at any time:

```text
/auto-update-now
```

## Security note

Installing this package opts the machine into automatic code updates from Pi and every package source configured in Pi. Review and trust those sources before installing this extension.

## Development

```bash
npm ci
npm run ci
pi --no-extensions -e ./extensions/auto-update.ts
```

## Release

Releases use npm Trusted Publishing through `.github/workflows/publish.yml`. The repository guard rejects direct `NPM_TOKEN` and `NODE_AUTH_TOKEN` references in workflow files.

## License

[MIT](LICENSE)
