import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindPacket, buildReviewPlan, MAX_REVIEW_BATCHES, reviewChangeSet, verifyReviewPlan } from "../extensions/security/batches.ts";
import { changes, hash, MAX_REVIEW_BYTES, reviewPayload, snapshot } from "../extensions/security/tree.ts";
import { modelReviewer } from "../extensions/security/review.ts";
const approve = (digest, extra = {}) => ({ schemaVersion: 1, candidate: digest, decision: "approve", complete: true, findings: [], reason: "Reviewed supplied code, dependency effects and interactions; no detected concern.", ...extra });

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "bounded-review-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const dir of ["before", "after"]) await mkdir(path.join(root, dir));
	const a = path.join(root, "before"), b = path.join(root, "after");
	const text = "// 雪😀 \"quoted\" \\ slash\r\n".repeat(9_000);
	await writeFile(path.join(a, "large.js"), text);
	await writeFile(path.join(b, "large.js"), text + "// harmless final comment\n");
	await writeFile(path.join(a, "removed.txt"), "removed\n".repeat(5_000));
	await writeFile(path.join(b, "added.txt"), "new text\n".repeat(5_000));
	for (const dir of [a, b]) {
		await writeFile(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}');
		// Large unchanged manifest set was a major contributor to the original failure.
		for (let i = 0; i < 30; i++) {
			await mkdir(path.join(dir, "manifests", String(i)), { recursive: true });
			await writeFile(path.join(dir, "manifests", String(i), "package.json"), JSON.stringify({ name: "fixture-" + i, description: "description".repeat(1_000) }));
		}
	}
	return { before: await snapshot(a), after: await snapshot(b) };
}

test("large unchanged native artifacts are stream-hashed without entering model context; changed opaque data still blocks", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "opaque-stream-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "native.node"), "");
	await truncate(path.join(root, "native.node"), 9 * 1024 * 1024);
	await writeFile(path.join(root, "small.js"), "export const version = 1;");
	const before = await snapshot(root);
	assert.equal(before.files.get("native.node").text, undefined);
	assert.equal(before.files.get("native.node").hash, hash(Buffer.alloc(9 * 1024 * 1024)));
	await writeFile(path.join(root, "small.js"), "export const version = 2;");
	const after = await snapshot(root);
	assert.deepEqual(changes(before, after).map((c) => c.path), ["small.js"]);
	let called = false;
	await reviewChangeSet("fixture", before, after, async (payload, binding) => {
		called = true; assert.ok(Buffer.byteLength(payload) < 8_192); return approve(binding);
	}, new AbortController().signal);
	assert.equal(called, true);
	await truncate(path.join(root, "native.node"), 9 * 1024 * 1024 + 1);
	const altered = await snapshot(root);
	assert.throws(() => changes(after, altered), /Changed binary/);
});

test("original >180KB rejection becomes lossless bounded coverage including huge files/manifests, Unicode and removals", async (t) => {
	const { before, after } = await fixture(t);
	assert.throws(() => reviewPayload("fixture", before, after), /size limit/);
	const plan = buildReviewPlan("fixture", before, after);
	verifyReviewPlan(plan, before, after);
	assert.ok(plan.batches.length > 1 && plan.batches.length <= MAX_REVIEW_BATCHES);
	const packets = [];
	let evidence;
	const verdict = await reviewChangeSet("fixture", before, after, async (payload, binding) => {
		assert.ok(Buffer.byteLength(payload) <= MAX_REVIEW_BYTES);
		const packet = JSON.parse(payload); packets.push(packet);
		const { candidate, ...body } = packet;
		assert.equal(candidate, binding);
		assert.equal(binding, hash(JSON.stringify(body)), "approval binds the entire packet, not a reusable tree-only digest");
		return approve(binding);
	}, new AbortController().signal, undefined, (value) => { evidence = value; });
	assert.equal(packets.at(-1).kind, "integration");
	for (const context of packets.at(-1).sourceContext) {
		for (const side of ["before", "after"]) {
			const text = (side === "before" ? before : after).files.get(context.path)?.text;
			for (const excerpt of context[side]?.excerpts ?? []) assert.equal(excerpt.text, text.slice(excerpt.start, excerpt.end));
		}
	}
	assert.equal(evidence.completed, evidence.batches);
	assert.equal(verdict.decision, "approve");
	assert.equal(new Set(evidence.packets.map((packet) => packet.binding)).size, packets.length);
	const all = packets.filter((packet) => packet.kind === "batch").flatMap((packet) => packet.units.map((unit) => ({
		...unit, descriptor: packet.files.find((file) => file.index === unit.file),
	})));
	for (const [name, original] of before.files) {
		if (!after.files.has(name) || after.files.get(name).hash !== original.hash) {
			assert.equal(all.filter((unit) => unit.descriptor.path === name).map((unit) => unit.before?.text ?? "").join(""), original.text);
		}
	}
	for (const [name, original] of after.files) {
		if (name.endsWith("package.json") || !before.files.has(name) || before.files.get(name).hash !== original.hash) {
			assert.equal(all.filter((unit) => unit.descriptor.path === name).map((unit) => unit.after?.text ?? "").join(""), original.text);
		}
	}
});

test("coverage verification rejects omissions, duplicates, reordered parts and tampering even with recomputed plan hashes", async (t) => {
	const { before, after } = await fixture(t);
	for (const tamper of [
		(plan) => plan.batches[0].shift(),
		(plan) => plan.batches[0].push(plan.batches[0][0]),
		(plan) => plan.batches[0].reverse(),
		(plan) => { plan.batches[0][0].after.text += "hidden"; },
		(plan) => { plan.batches[0][0].after.start++; },
		(plan) => { plan.files[0].path = "different"; },
		(plan) => { plan.batches[0][0].unchanged = !plan.batches[0][0].unchanged; },
		(plan) => { plan.files.find((file) => file.changeWindow).changeWindow.before[0]++; },
	]) {
		const plan = buildReviewPlan("fixture", before, after);
		tamper(plan); plan.digest = hash(JSON.stringify({ ...plan, digest: undefined }));
		assert.throws(() => verifyReviewPlan(plan, before, after), /coverage|part|omitted|altered|file/);
	}
});

for (const failure of ["second-finding", "second-error", "second-incomplete", "second-replay", "integration-block", "integration-replay"]) {
	test(failure + " cannot authorize the candidate after partial approvals", async (t) => {
		const { before, after } = await fixture(t);
		let first, count = 0;
		await assert.rejects(reviewChangeSet("fixture", before, after, async (payload, binding) => {
			const packet = JSON.parse(payload); count++;
			if (!first) first = approve(binding);
			if (count === 2 && failure === "second-finding") return approve(binding, { decision: "block", findings: [{ severity: "low", description: "injected concern" }] });
			if (count === 2 && failure === "second-error") throw new Error("provider unavailable");
			if (count === 2 && failure === "second-incomplete") return approve(binding, { complete: false });
			if ((count === 2 && failure === "second-replay") || (packet.kind === "integration" && failure === "integration-replay")) return first;
			if (packet.kind === "integration" && failure === "integration-block") return approve(binding, { decision: "block" });
			return approve(binding);
		}, new AbortController().signal));
		assert.ok(count >= 2);
	});
}

test("model-sized budgets apply to every batch and the integration request", async (t) => {
	const { before, after } = await fixture(t);
	const reviewer = async (payload, binding) => {
		assert.ok(Buffer.byteLength(payload) <= 100_000);
		return approve(binding);
	};
	reviewer.maxPayloadBytes = () => 100_000;
	await reviewChangeSet("fixture", before, after, reviewer, new AbortController().signal);
});

test("excessive review volume fails before any inference instead of truncating or unbounded spending", async (t) => {
	const { before, after } = await fixture(t);
	after.files.set("large.js", { ...after.files.get("large.js"), text: "a".repeat(8_000_000) });
	let calls = 0;
	await assert.rejects(reviewChangeSet("fixture", before, after, async () => { calls++; }, new AbortController().signal), /too many batches/);
	assert.equal(calls, 0);
});

test("cancellation stops the pipeline even if a reviewer ignores its signal", async (t) => {
	const { before, after } = await fixture(t), controller = new AbortController();
	const work = reviewChangeSet("fixture", before, after, async () => { controller.abort(); return new Promise(() => {}); }, controller.signal);
	await assert.rejects(work, /cancelled|aborted/);
});

test("overlong batch evidence is not silently truncated to fit the integration review", async (t) => {
	const { before, after } = await fixture(t);
	await assert.rejects(reviewChangeSet("fixture", before, after, async (_payload, binding) => approve(binding, {
		reason: "x".repeat(3_000),
	}), new AbortController().signal), /evidence exceeds/);
});
