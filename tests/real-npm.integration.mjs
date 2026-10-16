import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { npm, run } from "../extensions/security/process.ts";
import { runSecurityUpdates } from "../extensions/security/gate.ts";
import { modelReviewer } from "../extensions/security/review.ts";
import { snapshot } from "../extensions/security/tree.ts";

// Explicit opt-in: real public-registry network traffic, no paid model inference or personal updates.
test("real npm resolve/ci/audit + reviewer adapter + exact promotion preserves CLI links without lifecycle execution", {
	skip: process.platform === "win32", timeout: 120_000,
}, async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "real-npm-gate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agent = path.join(root, "agent"), live = path.join(agent, "npm");
	await mkdir(live, { recursive: true });
	await writeFile(path.join(agent, "settings.json"), '{"packages":["npm:is-number"]}');
	// Forces the real npm pipeline through segmentation (old planner rejected this manifest).
	const manifest = { private: true, description: "synthetic oversized manifest context ".repeat(6_000), dependencies: { "is-number": "6.0.0", acorn: "8.14.0" }, scripts: {
		preinstall: "node -e \"require('fs').writeFileSync('LIFECYCLE_RAN','bad')\"",
		install: "node -e \"require('fs').writeFileSync('LIFECYCLE_RAN','bad')\"",
		postinstall: "node -e \"require('fs').writeFileSync('LIFECYCLE_RAN','bad')\"",
	} };
	await writeFile(path.join(live, "package.json"), JSON.stringify(manifest));
	const signal = new AbortController().signal;
	await npm(run, ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], live, signal);
	const binPath = "node_modules/.bin/acorn";
	const binTarget = await readlink(path.join(live, binPath));
	assert.equal(binTarget, "../acorn/bin/acorn");
	let reviewCount = 0;
	const reviewer = modelReviewer({
		model: { provider: "fixture", id: "scripted-security-review", contextWindow: 200_000 },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			streamSimple: (_model, context) => {
				const payload = JSON.parse(context.messages[0].content[0].text);
				assert.ok(Buffer.byteLength(context.messages[0].content[0].text) <= 180_000);
				assert.ok(["batch", "integration"].includes(payload.kind));
				assert.deepEqual(context.tools, []);
				reviewCount++;
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
					schemaVersion: 1, candidate: payload.candidate, decision: "approve", complete: true, findings: [],
					reason: "Scripted integration fixture, not a live security judgment.",
				}) }] }) };
			},
		},
	}, () => {});
	const { report } = await runSecurityUpdates({ agentDir: agent, signal, reviewer });
	assert.equal(report.results[0].status, "updated", JSON.stringify(report));
	assert.ok(reviewCount > 2);
	assert.equal(report.results[0].review.mode, "batched");
	assert.equal(report.results[0].review.completed, report.results[0].review.batches);
	assert.equal(report.results[0].review.coverageVerified, true);
	assert.equal((await snapshot(live)).digest, report.results[0].candidate);
	assert.equal(await readlink(path.join(live, binPath)), binTarget);
	assert.equal(await readlink(path.join(report.results[0].backup, binPath)), binTarget);
	assert.equal(await realpath(path.join(live, binPath)), await realpath(path.join(live, "node_modules/acorn/bin/acorn")));
	assert.equal(JSON.parse(await readFile(path.join(live, "node_modules/is-number/package.json"), "utf8")).version, "7.0.0");
	await assert.rejects(access(path.join(live, "LIFECYCLE_RAN")), { code: "ENOENT" });
	await assert.rejects(access(path.join(report.results[0].backup, "LIFECYCLE_RAN")), { code: "ENOENT" });
});
