# Changelog

All notable changes to this project are documented here.

## [0.1.3] - 2026-08-13

### Fixed

- Defer Windows extension updates while an active Pi/intercom runtime may hold package files open.
- Treat known Windows package-lock errors (`EBUSY`, `-4082`, and `4294963214`) as deferred updates and continue checking Pi itself.

## [0.1.2] - 2026-08-13

### Fixed

- Invoke the Windows `pi.cmd` shim through `cmd.exe` so startup and manual updates work with npm and pnpm installations.
- Fix the publish guard's workflow path handling on Windows.

## [0.1.1] - 2026-08-11

### Changed

- Align the README with the current Pi extension template, including the standard badge set, install paths, quick start, package contents, docs, security, and project links.
- Include `docs/` in the published package so README release links remain available from npm.

## [0.1.0] - 2026-08-11

### Added

- Run `pi update --extensions` and then `pi update` at Pi process startup.
- Skip automatic updates in offline mode or when `PI_AUTO_UPDATE=0`.
- Add `/auto-update-now` for manual update checks.
- Report progress and non-fatal failures in the Pi UI.
