import assert from "node:assert/strict";
import test from "node:test";

import { isWindowsPackageLockFailure } from "../extensions/auto-update.ts";

const lockMessages = [
	"EBUSY",
	"ebusy",
	"eBuSy",
	"4294963214",
	"-4082",
	"npm error code EBUSY\nnpm error resource busy or locked, rename package",
	"Process exited with code 4294963214",
	"npm error errno -4082",
];

// Call only the classifier with explicit platforms: no Pi session, environment
// switches, or update subprocesses are involved.
test("recognizes Windows package-lock codes alone and in error output", () => {
	for (const message of lockMessages) {
		assert.equal(isWindowsPackageLockFailure(message, "win32"), true, message);
	}
});

test("rejects unrelated errors and near-match tokens on Windows", () => {
	for (const message of [
		"",
		"Update completed successfully",
		"npm error code EACCES: permission denied",
		"npm error code ENOTFOUND: registry lookup failed",
		"EBUSY_EXTRA",
		"14294963214",
		"-40820",
	]) {
		assert.equal(isWindowsPackageLockFailure(message, "win32"), false, message);
	}
});

for (const platform of ["linux", "darwin"]) {
	test(`rejects Windows package-lock messages on ${platform}`, () => {
		for (const message of lockMessages) {
			assert.equal(isWindowsPackageLockFailure(message, platform), false, message);
		}
	});
}
