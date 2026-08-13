import assert from "node:assert/strict";
import test from "node:test";

import autoUpdate from "../extensions/auto-update.ts";

// The test command may itself run inside a Pi/intercom process. Keep the
// default cases deterministic; the dedicated Windows test sets this signal.
delete process.env.PI_INTERCOM_SESSION_ID;

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

	const expectedCalls =
		process.platform === "win32"
			? [
					[process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", "pi update --extensions"],
					[process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", "pi update"],
				]
			: [
					["pi", "update", "--extensions"],
					["pi", "update"],
				];
	assert.deepEqual(harness.calls, expectedCalls);
	assert.deepEqual(harness.statuses.at(-1), ["pi-auto-update", undefined]);
	assert.match(harness.notifications.at(-1)[0], /completed/);
});

test("invokes the Windows Pi shim through the command processor", async () => {
	const originalPlatform = process.platform;
	const originalComSpec = process.env.ComSpec;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

	try {
		const harness = createHarness();
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

		assert.deepEqual(harness.calls, [
			["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "pi update --extensions"],
			["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "pi update"],
		]);
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
		if (originalComSpec === undefined) delete process.env.ComSpec;
		else process.env.ComSpec = originalComSpec;
	}
});

test("skips the Windows extension update while intercom is active", async () => {
	const originalPlatform = process.platform;
	const originalSessionId = process.env.PI_INTERCOM_SESSION_ID;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	process.env.PI_INTERCOM_SESSION_ID = "session-123";

	try {
		const harness = createHarness();
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

		assert.deepEqual(harness.calls, [
			[process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", "pi update"],
		]);
		assert.match(harness.notifications.at(-1)[0], /extensions: skipped/);
		assert.equal(harness.notifications.at(-1)[1], "info");
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
		if (originalSessionId === undefined) delete process.env.PI_INTERCOM_SESSION_ID;
		else process.env.PI_INTERCOM_SESSION_ID = originalSessionId;
	}
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

test("defers a Windows package lock failure and continues with Pi update", async () => {
	const originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

	try {
		const harness = createHarness([
			{
				stdout: "",
				stderr: "npm ERR! code EBUSY\nnpm ERR! exit code 4294963214",
				code: 1,
				killed: false,
			},
			{ stdout: "already current", stderr: "", code: 0, killed: false },
		]);
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);

		assert.equal(harness.calls.length, 2);
		assert.match(harness.notifications.at(-1)[0], /extensions: deferred/);
		assert.equal(harness.notifications.at(-1)[1], "info");
	} finally {
		Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	}
});

test("manual command runs updates even when automatic updates are disabled", async () => {
	const harness = createHarness();
	await harness.commands.get("auto-update-now").handler("", harness.ctx);
	assert.equal(harness.calls.length, 2);
});
