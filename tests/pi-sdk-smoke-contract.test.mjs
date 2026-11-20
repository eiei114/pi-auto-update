import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { behaviorAssertions, parseJsonLines, startupConfiguration, withoutEnvironmentKeys } from "../scripts/pi-sdk-smoke-contract.mjs";

const commandInventory = {
	type: "response",
	command: "get_commands",
	success: true,
	data: { commands: [{ name: "auto-update-now", source: "extension" }] },
};
const handledPrompt = {
	type: "response",
	command: "prompt",
	success: true,
	data: { disposition: "handled" },
};
const successNotification = {
	type: "extension_ui_request",
	method: "notify",
	message: "Pi extensions and Pi update checks completed",
	notifyType: "info",
};
const errorNotification = {
	type: "extension_ui_request",
	method: "notify",
	message: "Pi auto-update failed\nextensions: exit 1\nPi: exit 1",
	notifyType: "warning",
};
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pinnedPiVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];

function passed(name, values) {
	return behaviorAssertions(name, values).every((item) => item.passed);
}

test("RPC smoke contract parses JSONL and accepts actual command registration and feature response", () => {
	assert.deepEqual(parseJsonLines('{"type":"response"}\nnot-json\n{"id":2}'), [
		{ type: "response" },
		{ id: 2 },
	]);
	assert.equal(passed("extension_load", { responses: [commandInventory], exit_code: 0 }), true);
	assert.equal(
		passed("happy_path", {
			responses: [commandInventory, handledPrompt, successNotification],
			updaterInvocations: ["update --extensions", "update"],
			exit_code: 0,
		}),
		true,
	);
});

test("RPC smoke contract fails closed when registration or the feature response is missing", () => {
	assert.equal(passed("extension_load", { responses: [], exit_code: 0 }), false);
	assert.equal(
		passed("happy_path", { responses: [commandInventory, handledPrompt], exit_code: 0 }),
		false,
	);
	assert.equal(
		passed("happy_path", { responses: [commandInventory, successNotification], exit_code: 0 }),
		false,
	);
	assert.equal(
		passed("happy_path", {
			responses: [commandInventory, handledPrompt, successNotification],
			updaterInvocations: ["update"],
			exit_code: 0,
		}),
		false,
	);
});

test("RPC smoke contract requires handled errors and second-process reload evidence", () => {
	assert.equal(passed("error_path", { responses: [handledPrompt, errorNotification], exit_code: 0 }), true);
	assert.equal(passed("error_path", { responses: [handledPrompt], exit_code: 0 }), false);
	assert.equal(
		passed("reload_cleanup", {
			responses: [commandInventory, handledPrompt, successNotification],
			updaterInvocations: ["update --extensions", "update"],
			exit_code: 0,
			processExited: true,
			timedOut: false,
			stdout: "rpc output",
			stderr: "",
		}),
		true,
	);
	assert.equal(
		passed("reload_cleanup", {
			responses: [commandInventory, successNotification],
			exit_code: 0,
			processExited: true,
			timedOut: false,
			stdout: "rpc output",
			stderr: "",
		}),
		false,
	);
	assert.equal(
		passed("reload_cleanup", {
			responses: [commandInventory, handledPrompt, successNotification],
			exit_code: 0,
			processExited: false,
			timedOut: true,
			stdout: "",
			stderr: "",
		}),
		false,
	);
});

test("offline startup evidence fails closed on missing skip, updater calls, or pre-disabled updates", () => {
	const offlineNotification = {
		...successNotification,
		message: "Pi auto-update skipped: offline mode",
	};
	const startupConfiguration = { offlineFlag: true, piOffline: null, piOfflineKeys: [], piAutoUpdate: "1" };
	const evidence = {
		responses: [commandInventory, offlineNotification],
		updaterInvocations: [],
		startupConfiguration,
	};
	assert.equal(passed("offline_startup", evidence), true);
	for (const invalid of [
		{ responses: [commandInventory] },
		{ responses: [commandInventory, successNotification] },
		{ responses: [commandInventory, { ...offlineNotification, notifyType: "warning" }] },
		{ responses: [offlineNotification] },
		{ responses: [{ ...commandInventory, success: false }, offlineNotification] },
		{ updaterInvocations: ["update --extensions"] },
		{ updaterInvocations: ["update"] },
		{ updaterInvocations: undefined },
		{ startupConfiguration: undefined },
		{ startupConfiguration: { ...startupConfiguration, offlineFlag: false } },
		{ startupConfiguration: { ...startupConfiguration, piOffline: "1" } },
		{ startupConfiguration: { ...startupConfiguration, piOfflineKeys: ["pi_offline"] } },
		{ startupConfiguration: { ...startupConfiguration, piOfflineKeys: undefined } },
		{ startupConfiguration: { ...startupConfiguration, piAutoUpdate: "0" } },
	]) {
		assert.equal(passed("offline_startup", { ...evidence, ...invalid }), false, JSON.stringify(invalid));
	}
});

test("offline startup strips inherited environment keys regardless of case and detects surviving aliases", () => {
	const inherited = {
		PI_OFFLINE: "1", pi_offline: "1", Pi_Offline: "yes",
		pi_auto_update: "0", pi_intercom_session_id: "inherited-session",
		Path: "preserved-path", UNRELATED: "preserved-value",
	};
	const isolated = withoutEnvironmentKeys(inherited, ["PI_OFFLINE", "PI_AUTO_UPDATE", "PI_INTERCOM_SESSION_ID"]);
	assert.deepEqual(isolated, { Path: "preserved-path", UNRELATED: "preserved-value" });
	assert.equal(inherited.pi_offline, "1", "sanitizing a copy must not alter the parent environment");
	isolated.PI_AUTO_UPDATE = "1";
	assert.deepEqual(startupConfiguration(["--offline"], isolated), {
		offlineFlag: true, piOffline: null, piOfflineKeys: [], piAutoUpdate: "1",
	});
	for (const key of ["PI_OFFLINE", "pi_offline", "Pi_Offline"]) {
		const contaminated = startupConfiguration(["--offline"], { ...isolated, [key]: "1" });
		assert.deepEqual(contaminated.piOfflineKeys, [key]);
		assert.equal(contaminated.piOffline, "1");
		const assertions = behaviorAssertions("offline_startup", { responses: [], startupConfiguration: contaminated });
		assert.equal(assertions.find((item) => item.id === "offline_startup_configuration").passed, false);
	}
});

test("smoke runner records reviewed head and node version in the committed report", () => {
	const source = readFileSync(new URL("../scripts/pi-sdk-smoke.mjs", import.meta.url), "utf8");
	assert.match(source, /head_sha:\s*resolveReviewedHeadSha\(\)/);
	assert.match(source, /node_version:\s*process\.version/);
	const report = JSON.parse(readFileSync(new URL("../docs/verification/pi-sdk-smoke.json", import.meta.url), "utf8"));
	assert.match(report.head_sha, /^[0-9a-f]{40}$/);
	assert.match(report.node_version, /^v\d+\.\d+\.\d+/);
});

test("native shell assertion requires the exact pinned Pi version", () => {
	assert.equal(
		passed("host_shell", {
			responses: [],
			exit_code: 0,
			stdout: `${pinnedPiVersion}\n`,
			stderr: "",
			expectedVersion: pinnedPiVersion,
		}),
		true,
	);
	assert.equal(
		passed("host_shell", {
			responses: [],
			exit_code: 0,
			stdout: "wrong-version\n",
			stderr: "",
			expectedVersion: pinnedPiVersion,
		}),
		false,
	);
});
