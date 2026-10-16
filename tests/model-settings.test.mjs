import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import autoUpdate from "../extensions/auto-update.ts";
import { parseAutoUpdateSettings, parseModelRef, readAutoUpdateSettings, writeReviewModel } from "../extensions/security/settings.ts";
import { modelReviewer, resolveReviewModel } from "../extensions/security/review.ts";

const luna = { provider: "openai-codex", id: "gpt-6-luna", contextWindow: 272_000 };
const sol = { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 272_000 };
const verdict = { schemaVersion: 1, candidate: "digest", decision: "approve", complete: true, findings: [], reason: "Test fixture" };

function context() {
	const called = [];
	const ctx = { model: sol, hasUI: true, ui: { notify: (...args) => called.push({ notification: args }) },
		modelRegistry: {
			find: (provider, id) => {
				called.push({ find: [provider, id] });
				return provider === luna.provider && id === luna.id ? luna : undefined;
			},
			hasConfiguredAuth: () => true,
			streamSimple: (model, messages) => {
				called.push({ model, messages });
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(verdict) }] }) };
			},
		} };
	return { ctx, called };
}

test("model settings use exact provider/model IDs and allow nested model names", () => {
	assert.deepEqual(parseModelRef("openrouter/anthropic/claude-sonnet-5"), { provider: "openrouter", id: "anthropic/claude-sonnet-5" });
	assert.deepEqual(parseAutoUpdateSettings(undefined), {});
	assert.deepEqual(parseAutoUpdateSettings({ reviewModel: "current" }), {});
	assert.deepEqual(parseAutoUpdateSettings({ reviewModel: "openai-codex/gpt-6-luna" }), { reviewModel: "openai-codex/gpt-6-luna" });
	for (const value of [null, [], false, { reviewModel: null }, { reviewModel: "" }, { reviewModel: "gpt-6-luna" },
		{ reviewModel: "openai-codex/" }, { reviewModel: "openai-codex/gpt 6" }, { reviewModle: "typo" }]) {
		assert.throws(() => parseAutoUpdateSettings(value));
	}
});

test("configured Luna overrides the session model without changing the chat model", async () => {
	const { ctx, called } = context();
	const recorded = [];
	await modelReviewer(ctx, (data) => recorded.push(data))("payload", "digest", new AbortController().signal, "openai-codex/gpt-6-luna");
	assert.equal(called.find((call) => call.model)?.model, luna);
	assert.deepEqual(called.find((call) => call.find)?.find, ["openai-codex", "gpt-6-luna"]);
	assert.equal(recorded[0].model, "openai-codex/gpt-6-luna");
	assert.equal(ctx.model, sol);
	assert.deepEqual(called.find((call) => call.messages).messages.tools, []);
});

test("unknown or unauthenticated configured models cannot fall back to the chat model", async () => {
	const { ctx, called } = context();
	await assert.rejects(modelReviewer(ctx, () => {})("payload", "digest", new AbortController().signal,
		"openai-codex/nonexistent"), /unavailable/);
	ctx.modelRegistry.hasConfiguredAuth = () => false;
	await assert.rejects(modelReviewer(ctx, () => {})("payload", "digest", new AbortController().signal,
		"openai-codex/gpt-6-luna"), /authenticated/);
	assert.equal(called.filter((call) => call.model).length, 0);
});

test("absent model override retains backwards-compatible current-model behavior", () => {
	const { ctx } = context();
	assert.equal(resolveReviewModel(ctx), sol);
});

async function fixture(t) {
	const agent = await mkdtemp(path.join(tmpdir(), "model-settings-"));
	t.after(() => rm(agent, { recursive: true, force: true }));
	const original = { defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol",
		packages: [{ source: "npm:example", extensions: [] }], theme: "dark" };
	const file = path.join(agent, "settings.json");
	await writeFile(file, JSON.stringify(original));
	return { agent, file, original };
}

test("saving review settings preserves chat defaults and package filters; current resets override", async (t) => {
	const f = await fixture(t);
	await writeReviewModel(f.agent, "openai-codex/gpt-6-luna");
	const saved = JSON.parse(await readFile(f.file, "utf8"));
	assert.deepEqual(saved, { ...f.original, autoUpdate: { reviewModel: "openai-codex/gpt-6-luna" } });
	assert.deepEqual(await readAutoUpdateSettings(f.agent), { reviewModel: "openai-codex/gpt-6-luna" });
	await writeReviewModel(f.agent, "current");
	assert.deepEqual(await readAutoUpdateSettings(f.agent), {});
	assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultModel, "gpt-6.1-sol");
	await assert.rejects(readFile(path.join(f.agent, ".auto-update-security.lock")), { code: "ENOENT" });
});

test("configuring a model cannot modify settings during another process's review", async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.file, "utf8");
	await writeFile(path.join(f.agent, ".auto-update-security.lock"), "other process");
	await assert.rejects(writeReviewModel(f.agent, "openai-codex/gpt-6-luna"), { code: "EEXIST" });
	assert.equal(await readFile(f.file, "utf8"), before);
});

test("slash command validates, persists and displays the selected reviewer without model inference", async (t) => {
	const f = await fixture(t);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.agent;
	t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
	const commands = new Map();
	autoUpdate({ on: () => {}, registerCommand: (name, command) => commands.set(name, command) });
	const { ctx, called } = context();
	await commands.get("auto-update-model").handler("openai-codex/gpt-6-luna", ctx);
	assert.deepEqual(await readAutoUpdateSettings(f.agent), { reviewModel: "openai-codex/gpt-6-luna" });
	await commands.get("auto-update-model").handler("", ctx);
	assert.match(called.at(-1).notification[0], /openai-codex\/gpt-6-luna/);
	const before = await readFile(f.file, "utf8");
	await commands.get("auto-update-model").handler("openai-codex/nonexistent", ctx);
	assert.equal(await readFile(f.file, "utf8"), before);
	assert.equal(called.at(-1).notification[1], "warning");
	await commands.get("auto-update-model").handler("current", ctx);
	assert.deepEqual(await readAutoUpdateSettings(f.agent), {});
	assert.equal(called.filter((call) => call.model).length, 0, "Configuring a model must not make an inference request");
});
