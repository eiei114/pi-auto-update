import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BOOTSTRAP_DOC_PATHS, scaffoldProject } from "../packages/create-pi-extension/src/scaffold.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages", "create-pi-extension", "src", "cli.mjs");

const FIXTURE_OPTIONS = {
  packageName: "fixture-pi-package",
  displayName: "fixture-pi-package",
  description: "Fixture Pi package",
  author: "Fixture Author",
  ownerRepo: "fixture-owner/fixture-pi-package",
  licenseYear: 2026,
};

function runCli(packageName, cwd, env = {}) {
  return execFileSync(process.execPath, [CLI, packageName], {
    cwd,
    env: {
      ...process.env,
      CREATE_PI_EXTENSION_YES: "1",
      CREATE_PI_EXTENSION_SKIP_POST_SETUP: "1",
      CREATE_PI_EXTENSION_AUTHOR: "Test Author",
      ...env,
    },
    encoding: "utf8",
  });
}

function readProject(cwd, directoryName) {
  const projectDir = join(cwd, directoryName);
  const packageJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
  const readme = readFileSync(join(projectDir, "README.md"), "utf8");
  const license = readFileSync(join(projectDir, "LICENSE"), "utf8");
  return { projectDir, packageJson, readme, license };
}

test("create-pi-extension scaffolds an unscoped package", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  try {
    runCli("my-pi-package", tempRoot);
    const { packageJson, readme, license } = readProject(tempRoot, "my-pi-package");

    assert.equal(packageJson.name, "my-pi-package");
    assert.equal(packageJson.author, "Test Author");
    assert.match(packageJson.repository.url, /github\.com\/.+\/my-pi-package$/);
    assert.equal(packageJson.scripts.ci, "npm run typecheck && npm test && npm run pack:check");
    assert.equal(packageJson.scripts["sync:template"], undefined);
    assert.equal(packageJson.scripts["sync:template:check"], undefined);
    assert.equal(packageJson.scripts["pack:check"], "npm pack --dry-run");
    assert.match(readme, /my-pi-package/);
    assert.doesNotMatch(readme, /PACKAGE_NAME|OWNER\/REPO|YOUR_NAME/);
    assert.match(license, /Test Author/);
    assert.doesNotMatch(license, /YOUR_NAME/);
    assert.equal(existsSync(join(tempRoot, "my-pi-package", "package-lock.json")), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("create-pi-extension scaffolds a scoped package without extra scope prompt", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  try {
    runCli("@my-scope/my-pi-tool", tempRoot);
    const { packageJson } = readProject(tempRoot, "my-pi-tool");

    assert.equal(packageJson.name, "@my-scope/my-pi-tool");
    assert.ok(existsSync(join(tempRoot, "my-pi-tool", "package.json")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("create-pi-extension removes bootstrap docs and prints next steps", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  try {
    const output = runCli("cleanup-pkg", tempRoot);
    const projectDir = join(tempRoot, "cleanup-pkg");

    for (const relativePath of BOOTSTRAP_DOC_PATHS) {
      assert.equal(existsSync(join(projectDir, relativePath)), false, `expected ${relativePath} to be removed`);
    }

    assert.match(output, /Removed bootstrap docs:/);
    assert.match(output, /docs\/github-template\.md/);
    assert.match(output, /docs\/repository-settings\.md/);
    assert.match(output, /docs\/template-sync\.md/);
    assert.match(output, /docs\/typescript\.md/);
    assert.match(output, /Edit extensions\//);
    assert.match(output, /Run bun run ci/);
    assert.match(output, /Try pi -e \./);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("create-pi-extension replaces template placeholders in scaffold output", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  const projectDir = join(tempRoot, "fixture-pi-package");
  try {
    scaffoldProject(projectDir, FIXTURE_OPTIONS);

    const packageJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf8"));
    const readme = readFileSync(join(projectDir, "README.md"), "utf8");
    const license = readFileSync(join(projectDir, "LICENSE"), "utf8");

    assert.deepEqual(
      {
        name: packageJson.name,
        author: packageJson.author,
        description: packageJson.description,
        repository: packageJson.repository,
        homepage: packageJson.homepage,
        bugs: packageJson.bugs,
      },
      {
        name: "fixture-pi-package",
        author: "Fixture Author",
        description: "Fixture Pi package",
        repository: {
          type: "git",
          url: "https://github.com/fixture-owner/fixture-pi-package",
        },
        homepage: "https://github.com/fixture-owner/fixture-pi-package#readme",
        bugs: {
          url: "https://github.com/fixture-owner/fixture-pi-package/issues",
        },
      },
    );
    assert.match(readme, /fixture-pi-package/);
    assert.doesNotMatch(readme, /PACKAGE_NAME|OWNER\/REPO|YOUR_NAME|\bOWNER\b|\bREPO\b/);
    assert.match(license, /Copyright \(c\) 2026 Fixture Author/);
    assert.doesNotMatch(license, /YOUR_NAME/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("create-pi-extension scaffold output excludes monorepo paths from bundled template", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  const projectDir = join(tempRoot, "fixture-pi-package");
  try {
    scaffoldProject(projectDir, FIXTURE_OPTIONS);

    assert.equal(existsSync(join(projectDir, "packages")), false);
    assert.equal(existsSync(join(projectDir, ".git")), false);
    assert.equal(existsSync(join(projectDir, "node_modules")), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("create-pi-extension runs git init and bun install when post-setup is enabled", { timeout: 120_000 }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "create-pi-extension-"));
  try {
    execFileSync(process.execPath, [CLI, "post-setup-pkg"], {
      cwd: tempRoot,
      env: {
        ...process.env,
        CREATE_PI_EXTENSION_YES: "1",
        CREATE_PI_EXTENSION_AUTHOR: "Test Author",
      },
      stdio: "pipe",
    });

    const projectDir = join(tempRoot, "post-setup-pkg");
    assert.ok(existsSync(join(projectDir, ".git")));
    assert.ok(existsSync(join(projectDir, "node_modules")));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
