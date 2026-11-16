# Release

`pi-auto-update` publishes to npm through GitHub Actions Trusted Publishing.

## Initial bootstrap publish

npm only allows Trusted Publisher configuration after the package exists. Publish `0.1.0` once from a maintainer machine using interactive `npm login`:

```bash
npm ci
npm run ci
npm publish --access public
```

Immediately after the package exists, configure Trusted Publishing below. Do not store the interactive login token in GitHub Secrets. Revoke the local token after setup when it is no longer needed.

## One-time Trusted Publishing setup

Configure npm Trusted Publishing for:

- Package: `pi-auto-update`
- Provider: GitHub Actions
- Owner: `eiei114`
- Repository: `pi-auto-update`
- Workflow: `publish.yml`

Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to repository workflows or secrets.

## Automated release flow

1. Update `package.json`, `CHANGELOG.md`, and the `README.md` install pin example in the same PR. The pin must match `package.json.version`; `npm test` fails otherwise.
2. Merge the PR to `main`. This does not start a release.
3. From the Actions tab, manually run **Auto Release** on the `main` branch. The workflow compares the package version with the latest stable `v<version>` tag reachable from `main`; it proceeds only when the new version is greater and its tag does not already exist. If it cannot verify the previous tag and its package version, it skips the release.
4. On a verified version bump, `auto-release.yml` creates `v<version>` and a GitHub Release, then dispatches `publish.yml`.
5. `publish.yml` validates and publishes the root package with provenance.

Reruns skip versions already present on npm.
