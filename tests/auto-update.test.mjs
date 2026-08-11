import assert from "node:assert/strict";
import test from "node:test";

import autoUpdate from "../extensions/auto-update.ts";

function createHarness(results = []) {
	const handlers = new Map();
	const commands = new Map();
	const calls = [];
	const statuses = [];
	const notifications = [];

	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		async exec(command, args) {
			calls.push([command, ...args]);
			return results.shift() ?? { stdout: "ok", stderr: "", code: 0, killed: false };
		},
	};

	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: {
			setStatus(key, value) {
				statuses.push([key, value]);
			},
			notify(message, level) {
				notifications.push([message, level]);
			},
		},
	};

	autoUpdate(pi);
	return { handlers, commands, calls, statuses, notifications, ctx };
}

test("runs extension update before Pi update on startup", async () => {
	const harness = createHarness();
	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

	assert.deepEqual(harness.calls, [
		["pi", "update", "--extensions"],
		["pi", "update"],
	]);
	assert.deepEqual(harness.statuses.at(-1), ["pi-auto-update", undefined]);
	assert.match(harness.notifications.at(-1)[0], /completed/);
});

test("does not rerun for replacement session events", async () => {
	const harness = createHarness();
	for (const reason of ["reload", "new", "resume", "fork"]) {
		await harness.handlers.get("session_start")({ reason }, harness.ctx);
	}
	assert.deepEqual(harness.calls, []);
});

test("skips startup updates when PI_AUTO_UPDATE is disabled", async () => {
	const original = process.env.PI_AUTO_UPDATE;
	process.env.PI_AUTO_UPDATE = "0";
	try {
		const harness = createHarness();
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
		assert.deepEqual(harness.calls, []);
		assert.match(harness.notifications.at(-1)[0], /disabled/);
	} finally {
		if (original === undefined) delete process.env.PI_AUTO_UPDATE;
		else process.env.PI_AUTO_UPDATE = original;
	}
});

test("continues after a failed extension update", async () => {
	const harness = createHarness([
		{ stdout: "", stderr: "registry unavailable", code: 1, killed: false },
		{ stdout: "already current", stderr: "", code: 0, killed: false },
	]);
	await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

	assert.equal(harness.calls.length, 2);
	assert.match(harness.notifications.at(-1)[0], /extensions: exit 1/);
	assert.equal(harness.notifications.at(-1)[1], "warning");
});

test("manual command runs updates even when automatic updates are disabled", async () => {
	const harness = createHarness();
	await harness.commands.get("auto-update-now").handler("", harness.ctx);
	assert.equal(harness.calls.length, 2);
});
