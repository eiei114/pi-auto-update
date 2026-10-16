# Changelog

## [Unreleased]

### Added

- Stage supported personal package updates without executing candidate scripts; audit dependencies and require complete, zero-finding AI review before promoting the exact reviewed files.
- Configure an independent reviewer with `autoUpdate.reviewModel` or `/auto-update-model`, using existing Pi authentication, including Codex OAuth.
- Retain backups, promotion journals, and review reports; block incomplete checks, findings, failures, and tampering.

### Changed

- Replace unconditional updater commands with a fail-closed gate. Pi-core, project-local, Windows, and unsupported update types are deferred; AI approval is not a vulnerability-free guarantee.
- Run automatic checks silently in the background without delaying startup or showing footer status/notifications; retain saved results and errors, manual-command feedback, coalescing, and shutdown cancellation.

### Fixed

- Preserve relative npm CLI symlinks when freezing reviewed candidates, avoiding false escaping-symlink blocks without weakening path or digest checks.
- Replace oversized single-payload rejection with bounded, lossless reviews of all required source/manifests and a final cross-batch review. Verify complete coverage, bind each approval to its packet, cap requests/time, and reject partial approvals before promotion.

## [0.1.8] - 2026-10-16

### Changed

- Pin the development Pi SDK to 1.2.0 and verify the extension against the actual Pi host.

## [0.1.7] - 2026-10-12

### Changed

- Pin the Pi SDK 1.1.0 development toolchain and add an actual Pi RPC compatibility smoke.
- Require an explicit workflow dispatch before starting the release flow.

## 0.1.5 - 2026-09-27

- chore: periodic patch bump after 7+ days without npm publish

All notable changes to this project are documented here.

## [0.1.6] - 2026-09-30

### Changed

- Update `@earendil-works/pi-*` dependencies to `0.99.1`.

## [0.1.4] - 2026-08-24

### Added

- Add an installed-package startup smoke test that packs the npm package, installs it into an isolated Pi agent directory, loads it through Pi's package resource loader, and verifies offline startup does not invoke update commands.

### Changed

- Document the installed-package smoke verification command for development handoff.

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
