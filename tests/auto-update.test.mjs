import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import autoUpdate from "../extensions/auto-update.ts";

async function harness(t) {
	const agent = await mkdtemp(path.join(tmpdir(), "auto-update-hook-"));
	await writeFile(path.join(agent, "settings.json"), '{"packages":[]}');
	const original = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE,
		PI_AUTO_UPDATE: process.env.PI_AUTO_UPDATE };
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.PI_OFFLINE; delete process.env.PI_AUTO_UPDATE;
	const handlers = new Map(), commands = new Map(), notifications = [], entries = [], statuses = [];
	const completion = Promise.withResolvers();
	t.after(async () => {
		await handlers.get("session_shutdown")?.();
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(agent, { recursive: true, force: true });
	});
	autoUpdate({
		on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (...args) => {
			entries.push(args);
			if (["auto-update-security-report", "auto-update-security-error"].includes(args[0])) completion.resolve(args);
		},
		exec: () => { throw new Error("Unconditional Pi updates must never be invoked"); },
	});
	const ctx = { cwd: "/untrusted/project", hasUI: true, ui: {
		notify: (...args) => notifications.push(args), setStatus: (...args) => statuses.push(args),
	} };
	return { agent, handlers, commands, notifications, entries, statuses, ctx, completed: completion.promise };
}

test("startup returns immediately and completes silently without unconditional updater commands", async (t) => {
	const h = await harness(t);
	assert.equal(h.handlers.get("session_start")({ reason: "startup" }, h.ctx), undefined);
	assert.equal(h.entries.length, 0, "startup must not wait for the security gate");
	const [name, result] = await h.completed;
	assert.equal(name, "auto-update-security-report");
	assert.deepEqual(result.report.results, []);
	assert.deepEqual(h.notifications, []);
	assert.deepEqual(h.statuses, []);
});

test("automatic staging and blocked results never write footer status or notifications", async (t) => {
	const h = await harness(t);
	await mkdir(path.join(h.agent, "npm"));
	await writeFile(path.join(h.agent, "settings.json"), '{"packages":["npm:example"]}');
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	const [name, { report }] = await h.completed;
	assert.equal(name, "auto-update-security-report");
	assert.equal(report.results[0].target, "personal npm packages");
	assert.equal(report.results[0].status, "blocked");
	assert.deepEqual(h.statuses, []);
	assert.deepEqual(h.notifications, []);
});

test("replacement events and duplicate startup notifications do not rerun updates", async (t) => {
	const h = await harness(t);
	for (const reason of ["reload", "new", "resume", "fork"]) {
		h.handlers.get("session_start")({ reason }, h.ctx);
	}
	assert.equal(h.entries.length, 0);
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.completed;
	await h.handlers.get("session_shutdown")();
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.equal(h.entries.filter(([name]) => name === "auto-update-security-report").length, 1);
	assert.deepEqual(h.notifications, []);
	assert.deepEqual(h.statuses, []);
});

test("offline startup is silent and the manual command cannot bypass offline mode", async (t) => {
	const h = await harness(t); process.env.PI_OFFLINE = "1";
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.deepEqual(h.notifications, []);
	assert.equal(h.entries.length, 0);
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /blocked: offline/);
	assert.equal(h.notifications.at(-1)[1], "warning");
	assert.deepEqual(h.entries, [["auto-update-security-error", { reason: "offline mode" }]]);
	assert.deepEqual(h.statuses, []);
});

test("manual invocation reports results despite automatic disable and never bypasses the gate", async (t) => {
	const h = await harness(t); process.env.PI_AUTO_UPDATE = "0";
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.deepEqual(h.notifications, []);
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /completed/);
	assert.deepEqual(h.statuses, []);
});

test("manual concurrent checks are coalesced and shutdown is safe", async (t) => {
	const h = await harness(t);
	await Promise.all([h.commands.get("auto-update-now").handler("", h.ctx), h.commands.get("auto-update-now").handler("", h.ctx)]);
	assert.equal(h.entries.filter(([name]) => name === "auto-update-security-report").length, 1);
	await h.handlers.get("session_shutdown")();
});

test("manual invocation joins an automatic check and still reports its result", async (t) => {
	const h = await harness(t);
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.equal(h.entries.filter(([name]) => name === "auto-update-security-report").length, 1);
	assert.equal(h.notifications.length, 1);
	assert.match(h.notifications[0][0], /completed/);
	assert.deepEqual(h.statuses, []);
});

test("automatic failures are recorded silently and shutdown handles rejection", async (t) => {
	const h = await harness(t);
	await writeFile(path.join(h.agent, "settings.json"), "malformed json");
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_shutdown")();
	assert.equal(h.entries[0][0], "auto-update-security-error");
	assert.equal(typeof h.entries[0][1].reason, "string");
	assert.deepEqual(h.notifications, []);
	assert.deepEqual(h.statuses, []);
});

test("manual failures still produce a warning", async (t) => {
	const h = await harness(t);
	await writeFile(path.join(h.agent, "settings.json"), "malformed json");
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /blocked:/);
	assert.equal(h.notifications.at(-1)[1], "warning");
});

test("shutdown cancels background work, waits for cleanup and remains silent", async (t) => {
	const h = await harness(t);
	await writeFile(path.join(h.agent, "settings.json"), '{"packages":["npm:example"]}');
	h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_shutdown")();
	const [name, { report }] = await h.completed;
	assert.equal(name, "auto-update-security-report");
	assert.equal(report.results[0].status, "blocked");
	assert.equal(report.results[0].reason, "Update cancelled");
	await assert.rejects(access(path.join(h.agent, ".auto-update-security.lock")), { code: "ENOENT" });
	assert.deepEqual(h.notifications, []);
	assert.deepEqual(h.statuses, []);
});
