import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowDirectory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const files = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/.test(name));

for (const file of files) {
	const content = await readFile(join(workflowDirectory, file), "utf8");
	assert.doesNotMatch(content, /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/, `${file} contains a long-lived npm token reference`);
}

console.log(`Checked ${files.length} workflow files: no long-lived npm token references.`);
