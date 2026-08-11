import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE_ROOT = join(ROOT, "packages", "create-pi-extension", "template");
const CLI_PACKAGE_JSON = join(ROOT, "packages", "create-pi-extension", "package.json");
const ROOT_PACKAGE_JSON = join(ROOT, "package.json");

function templatePath(...segments) {
  return join(TEMPLATE_ROOT, ...segments);
}

test("synced template contains expected scaffold files", () => {
  for (const relativePath of [
    "package.json",
    "README.md",
    "extensions/index.ts",
    "docs/examples.md",
    ".github/workflows/ci.yml",
  ]) {
    assert.ok(existsSync(templatePath(relativePath)), `missing ${relativePath}`);
  }
});

test("synced template excludes monorepo paths", () => {
  assert.equal(existsSync(templatePath("packages")), false);
  assert.equal(existsSync(templatePath(".git")), false);
  assert.equal(existsSync(templatePath("package-lock.json")), false);
  assert.equal(existsSync(templatePath("ROADMAP.md")), false);
});

test("synced template package.json is standalone", () => {
  const templatePackageJson = JSON.parse(readFileSync(templatePath("package.json"), "utf8"));
  assert.equal(templatePackageJson.workspaces, undefined);
  assert.equal(templatePackageJson.scripts?.["sync:template"], undefined);
  assert.equal(templatePackageJson.scripts?.["sync:template:check"], undefined);
  assert.equal(templatePackageJson.name, "pi-extension-template");
  assert.equal(templatePackageJson.scripts?.["pack:check"], "npm pack --dry-run");
});

test("synced template README comes from scaffold source", () => {
  const scaffoldReadme = readFileSync(join(ROOT, "scaffold", "package-readme.md"), "utf8");
  const templateReadme = readFileSync(templatePath("README.md"), "utf8");
  assert.equal(templateReadme, scaffoldReadme);
  assert.match(templateReadme, /PACKAGE_DISPLAY_NAME/);
  assert.doesNotMatch(templateReadme, /bunx create-pi-extension/);
});

test("create-pi-extension version matches repository version", () => {
  const rootPackageJson = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, "utf8"));
  const cliPackageJson = JSON.parse(readFileSync(CLI_PACKAGE_JSON, "utf8"));
  assert.equal(cliPackageJson.version, rootPackageJson.version);
  assert.equal(cliPackageJson.name, "create-pi-extension");
});
