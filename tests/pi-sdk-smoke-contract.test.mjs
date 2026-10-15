import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { behaviorAssertions, parseJsonLines } from "../scripts/pi-sdk-smoke-contract.mjs";

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
			stdout: "1.2.0\n",
			stderr: "",
			expectedVersion: "1.2.0",
		}),
		true,
	);
	assert.equal(
		passed("host_shell", {
			responses: [],
			exit_code: 0,
			stdout: "0.99.1\n",
			stderr: "",
			expectedVersion: "1.2.0",
		}),
		false,
	);
});
