import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repoRoot = new URL("..", import.meta.url);
const readme = readFileSync(new URL("README.md", repoRoot), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));

test("README install pin example matches the package.json version", () => {
	const pins = [...readme.matchAll(/pi install npm:pi-auto-update@([0-9A-Za-z.-]+)/g)].map((match) => match[1]);
	assert.ok(pins.length > 0, "README must keep a pinned install example");
	for (const pin of pins) {
		assert.equal(pin, packageJson.version, `README pins ${pin} but package.json is ${packageJson.version}`);
	}
});

test("README release section describes the manual owner-run Auto Release flow", () => {
	const releaseSection = readme.split(/^## Release$/m)[1]?.split(/^## /m)[0];
	assert.ok(releaseSection, "README must keep a Release section");
	assert.match(releaseSection, /run \*\*Auto Release\*\* manually on the `main` branch/);
	assert.match(releaseSection, /does not publish anything|does not start a release/);
	assert.doesNotMatch(releaseSection, /npm version (patch|minor|major)/);
	assert.doesNotMatch(releaseSection, /^```\n?git push$/m);
});

test("README release section names the install pin as part of the version bump", () => {
	const releaseSection = readme.split(/^## Release$/m)[1]?.split(/^## /m)[0];
	assert.ok(releaseSection, "README must keep a Release section");
	assert.match(releaseSection, /README\.md` install pin example/);
	assert.match(releaseSection, /pi install npm:pi-auto-update@<version>/);
});

test("README package contents lists the repository scripts and tests", () => {
	const contentsSection = readme.split(/^## Package contents$/m)[1]?.split(/^## /m)[0];
	assert.ok(contentsSection, "README must keep a Package contents section");
	assert.match(contentsSection, /\| `scripts\/` \|/);
	assert.match(contentsSection, /\| `tests\/` \|/);
});
