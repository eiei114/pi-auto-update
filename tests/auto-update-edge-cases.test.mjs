import assert from "node:assert/strict";
import test from "node:test";

import autoUpdate from "../extensions/auto-update.ts";

const STATUS_KEY = "pi-auto-update";

// The test command may itself run inside a Pi/intercom process, and CI or a
// developer shell may export these switches. Start every case from a known
// state and restore the inherited values afterwards.
const inheritedEnv = {
	PI_INTERCOM_SESSION_ID: process.env.PI_INTERCOM_SESSION_ID,
	PI_OFFLINE: process.env.PI_OFFLINE,
	PI_AUTO_UPDATE: process.env.PI_AUTO_UPDATE,
};
for (const key of Object.keys(inheritedEnv)) delete process.env[key];

test.after(() => {
	for (const [key, value] of Object.entries(inheritedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function setEnv(values) {
	const saved = new Map();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

function piInvocation(args) {
	if (process.platform !== "win32") return ["pi", ...args];
	const comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
	return [comSpec, "/d", "/s", "/c", ["pi", ...args].join(" ")];
}

function createCtx(overrides = {}) {
	const statuses = [];
	const notifications = [];
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
		...overrides,
	};
	return { ctx, statuses, notifications };
}

function createPi(exec) {
	const handlers = new Map();
	const commands = new Map();
	const calls = [];
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		exec(command, args) {
			calls.push([command, ...args]);
			return exec(command, args, calls.length);
		},
	};
	autoUpdate(pi);
	return { handlers, commands, calls };
}

function ok(stdout = "ok") {
	return { stdout, stderr: "", code: 0, killed: false };
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("PI_OFFLINE truthy values skip startup updates without calling pi", async () => {
	for (const value of ["1", "true", "yes"]) {
		const restore = setEnv({ PI_OFFLINE: value, PI_AUTO_UPDATE: undefined });
		try {
			const surface = createCtx();
			const harness = createPi(async () => ok());
			await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

			assert.equal(harness.calls.length, 0, `PI_OFFLINE=${value} must not exec pi`);
			assert.equal(surface.notifications.length, 1);
			assert.equal(surface.notifications[0][0], "Pi auto-update skipped: offline mode");
			assert.equal(surface.notifications[0][1], "info");
			assert.deepEqual(surface.statuses, []);
		} finally {
			restore();
		}
	}
});

test("PI_OFFLINE wins over PI_AUTO_UPDATE=1", async () => {
	const restore = setEnv({ PI_OFFLINE: "1", PI_AUTO_UPDATE: "1" });
	try {
		const surface = createCtx();
		const harness = createPi(async () => ok());
		await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

		assert.equal(harness.calls.length, 0);
		assert.equal(surface.notifications.at(-1)[0], "Pi auto-update skipped: offline mode");
	} finally {
		restore();
	}
});

test("manual command still runs updates while offline", async () => {
	const restore = setEnv({ PI_OFFLINE: "1", PI_AUTO_UPDATE: undefined });
	try {
		const surface = createCtx();
		const harness = createPi(async () => ok());

		await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);
		assert.equal(harness.calls.length, 0);

		await harness.commands.get("auto-update-now").handler("", surface.ctx);
		assert.deepEqual(harness.calls, [piInvocation(["update", "--extensions"]), piInvocation(["update"])]);
	} finally {
		restore();
	}
});

test("dedups a concurrent manual run and clears inFlight after completion", async () => {
	const resolvers = [];
	let completeImmediately = false;
	const harness = createPi((_command, _args, _count) => {
		if (completeImmediately) return Promise.resolve(ok());
		return new Promise((resolve) => resolvers.push(resolve));
	});
	const surface = createCtx();

	const startup = harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);
	await waitFor(() => harness.calls.length === 1, "the first extensions exec call");
	assert.equal(resolvers.length, 1);

	// The manual command joins the in-flight startup run instead of starting a
	// second pair of update commands.
	const manual = harness.commands.get("auto-update-now").handler("", surface.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.calls.length, 1, "a concurrent manual run must not exec pi on its own");

	resolvers[0](ok());
	await waitFor(() => harness.calls.length === 2, "the Pi update exec call");
	assert.equal(resolvers.length, 2);
	resolvers[1](ok());

	await Promise.all([startup, manual]);
	assert.deepEqual(harness.calls, [piInvocation(["update", "--extensions"]), piInvocation(["update"])]);
	assert.equal(surface.notifications.length, 1, "both handlers share one notification");
	assert.equal(surface.notifications[0][0], "Pi extensions and Pi update checks completed");
	assert.deepEqual(surface.statuses.at(-1), [STATUS_KEY, undefined]);

	// inFlight is cleared in .finally, so a later manual run executes again.
	completeImmediately = true;
	await harness.commands.get("auto-update-now").handler("", surface.ctx);
	assert.equal(harness.calls.length, 4);
	assert.equal(surface.notifications.length, 2);
});

test("reports a rejected exec as a failure and still runs the Pi step", async () => {
	const longMessage = "timeout after 15 minutes ".repeat(20).trim();
	assert.ok(longMessage.length > 300);
	const harness = createPi(async (_command, _args, count) => {
		if (count === 1) throw new Error(longMessage);
		return ok("already current");
	});
	const surface = createCtx();

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.equal(harness.calls.length, 2, "the Pi step still runs after a rejected extension step");
	assert.deepEqual(harness.calls[1], piInvocation(["update"]));
	assert.equal(surface.notifications.length, 1);
	const [message, level] = surface.notifications[0];
	assert.equal(level, "warning");
	assert.ok(message.startsWith("Pi auto-update failed\n"));
	assert.ok(message.includes(`extensions: ${longMessage.slice(0, 300)}`));
	assert.ok(!message.includes(longMessage.slice(0, 301)), "the failure detail is cut at 300 characters");
	assert.ok(!message.includes("Pi: exit"), "the successful Pi step contributes no failure line");
	assert.deepEqual(surface.statuses.at(-1), [STATUS_KEY, undefined]);
});

test("reports a non-Error rejection string as a failure", async () => {
	const harness = createPi(async (_command, _args, count) => {
		if (count === 1) throw "exec rejected";
		return ok();
	});
	const surface = createCtx();

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.equal(harness.calls.length, 2);
	assert.equal(surface.notifications[0][0], "Pi auto-update failed\nextensions: exec rejected");
	assert.equal(surface.notifications[0][1], "warning");
});

test("uses the last non-empty stderr line for a failed Pi update", async () => {
	const harness = createPi(async (_command, _args, count) => {
		if (count === 1) return ok();
		return {
			stdout: "stdout first line\nstdout last line",
			stderr: "warning: deprecated flag\n\r\n  npm ERR! boom  \r\n\r\n\r\n",
			code: 1,
			killed: false,
		};
	});
	const surface = createCtx();

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.equal(harness.calls.length, 2);
	assert.equal(surface.notifications[0][1], "warning");
	assert.ok(surface.notifications[0][0].includes("Pi: exit 1 — npm ERR! boom"));
	assert.ok(!surface.notifications[0][0].includes("deprecated flag"), "earlier stderr lines are not reported");
	assert.ok(!surface.notifications[0][0].includes("stdout last line"), "stderr wins over stdout");
	assert.ok(!surface.notifications[0][0].includes("extensions:"), "the successful extension step reports nothing");
});

test("falls back to stdout when stderr is empty and caps the detail", async () => {
	const harness = createPi(async (_command, _args, count) => {
		if (count === 1) return ok();
		const detail = "y".repeat(400);
		return { stdout: `starting\n${detail}\r\n\r\n`, stderr: "", code: 2, killed: false };
	});
	const surface = createCtx();

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.ok(surface.notifications[0][0].includes(`Pi: exit 2 — ${"y".repeat(300)}`));
	assert.ok(!surface.notifications[0][0].includes("y".repeat(301)), "the detail is cut at 300 characters");
});

test("runs updates without touching the UI when ctx.hasUI is false", async () => {
	const surface = createCtx({ hasUI: false });
	const harness = createPi(async () => ok());

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.deepEqual(harness.calls, [piInvocation(["update", "--extensions"]), piInvocation(["update"])]);
	assert.deepEqual(surface.notifications, []);
	assert.deepEqual(surface.statuses.at(-1), [STATUS_KEY, undefined]);
});

test("skips the notification but records the status handoff when hasUI is false and updates fail", async () => {
	const surface = createCtx({ hasUI: false });
	const harness = createPi(async () => ({ stdout: "", stderr: "offline", code: 1, killed: false }));

	await harness.handlers.get("session_start")({ reason: "startup" }, surface.ctx);

	assert.equal(harness.calls.length, 2);
	assert.deepEqual(surface.notifications, []);
	assert.deepEqual(surface.statuses.at(-1), [STATUS_KEY, undefined]);
});
