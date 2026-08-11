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

1. Update `package.json` and `CHANGELOG.md` in the same PR.
2. Merge the PR to `main`.
3. `auto-release.yml` detects the version change, creates `v<version>` and a GitHub Release, then dispatches `publish.yml`.
4. `publish.yml` validates and publishes the root package with provenance.

Reruns skip versions already present on npm.
