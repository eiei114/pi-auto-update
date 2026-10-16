/**
 * Opt-in proof using real installed npm/Git sources. Stages/audits and optionally reviews,
 * NEVER promotes/updates installed files. No prompts, credentials or source are written to the report.
 * Usage: node scripts/verify-bounded-review.mjs --agent-dir ~/.pi/agent [--target npm|git]
 *   [--sdk /absolute/path/to/pi/dist/index.js --model openai-codex/gpt-6-luna] --output /tmp/proof.json
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { snapshot, reviewPayload, MAX_REVIEW_BYTES } from "../extensions/security/tree.ts";
import { buildReviewPlan, reviewChangeSet, verifyReviewPlan } from "../extensions/security/batches.ts";
import { planTargets, stageTarget } from "../extensions/security/targets.ts";
import { run } from "../extensions/security/process.ts";
import { modelReviewer } from "../extensions/security/review.ts";

const { values } = parseArgs({ options: {
	"agent-dir": { type: "string" }, target: { type: "string", default: "npm" },
	sdk: { type: "string" }, model: { type: "string" }, output: { type: "string" }, fixture: { type: "boolean", default: false },
} });
if (!values["agent-dir"] || !values.output || (!!values.sdk !== !!values.model)) throw new Error("Provide --agent-dir and --output; live inference requires both --sdk and --model");
const agent = path.resolve(values["agent-dir"]);
const root = await mkdtemp(path.join(tmpdir(), "pi-bounded-proof-"));
let target;
if (values.fixture) {
	const live = path.join(root, "synthetic-baseline");
	await mkdir(live);
	await mkdir(path.join(root, "candidate"));
	for (const [directory, version] of [[live, "1.0.0"], [path.join(root, "candidate"), "1.0.1"]]) {
		await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "isolated-review-fixture", version, private: true,
			description: "Documentation for an isolated dependency-free test fixture. ".repeat(4_000) }));
	}
	target = { kind: "synthetic", live, label: "Synthetic benign manifest-only version change; no application behavior or dependencies" };
} else {
	target = planTargets(agent, JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"))).targets.find((target) => target.kind === values.target);
}
if (!target) { await rm(root, { recursive: true, force: true }); throw new Error("No matching target"); }
const signal = AbortSignal.timeout(20 * 60_000);
const baseline = await snapshot(target.live);
const proof = { schemaVersion: 1, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	targetKind: target.kind, packetLimit: MAX_REVIEW_BYTES, started: new Date().toISOString(),
	baseline: baseline.digest, sourceUnchanged: false, promotions: 0 };
try {
	const stage = path.join(root, "candidate");
	if (!values.fixture) await stageTarget(target, stage, baseline, run, signal);
	const candidate = await snapshot(stage);
	proof.candidate = candidate.digest;
	if (candidate.digest === baseline.digest) {
		proof.outcome = "unchanged";
		proof.liveModel = values.model ?? null;
	} else {
	const old = reviewPayload(target.label, baseline, candidate, Number.MAX_SAFE_INTEGER);
	proof.oldPayloadBytes = Buffer.byteLength(old);
	try { reviewPayload(target.label, baseline, candidate); proof.oldPlanner = "fits"; }
	catch (error) { proof.oldPlanner = error.message; }
	const plan = buildReviewPlan(target.label, baseline, candidate);
	verifyReviewPlan(plan, baseline, candidate);
	proof.coverageVerified = true;
	proof.sourceBatches = plan.batches.length;
	proof.parts = plan.batches.flat().length;
	proof.files = plan.files.length;
	proof.liveModel = values.model ?? null;
	let reviewer;
	if (values.sdk) {
		const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(path.resolve(values.sdk)).href);
		const runtime = await ModelRuntime.create({ authPath: path.join(agent, "auth.json"), modelsPath: null, allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		reviewer = modelReviewer({ modelRegistry: registry }, () => {});
	} else {
		reviewer = async (_payload, binding) => ({ schemaVersion: 1, candidate: binding, decision: "approve", complete: true,
			findings: [], reason: "Scripted mechanism proof, not a security judgment." });
	}
	try {
		proof.verdict = await reviewChangeSet(target.label, baseline, candidate, reviewer, signal, values.model, (evidence) => {
			proof.review = evidence;
			console.error(JSON.stringify({ completed: evidence.completed, required: evidence.batches, lastKind: evidence.packets.at(-1)?.kind }));
		});
		proof.outcome = "approved";
	} catch (error) { proof.outcome = "blocked"; proof.reason = error.message; }
	}
	proof.sourceUnchanged = (await snapshot(target.live)).digest === baseline.digest;
	if (!proof.sourceUnchanged) throw new Error("Source changed during read-only proof; rerun against a stable source");
} finally {
	await rm(root, { recursive: true, force: true });
	// Only bounded metadata/verdicts, never complete source payloads.
	await writeFile(values.output, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
}
console.log(JSON.stringify({ ...proof, review: proof.review && {
	...proof.review, packets: proof.review.packets.map((packet) => ({ kind: packet.kind, bytes: packet.bytes,
		binding: packet.binding, decision: packet.verdict?.decision })),
} }, null, 2));
