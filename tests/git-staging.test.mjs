import assert from "node:assert/strict";
import { execFile as exec } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runSecurityUpdates } from "../extensions/security/gate.ts";
import { run } from "../extensions/security/process.ts";
const execFile = promisify(exec);
const skip = process.platform === "win32";
const git = async (args, cwd) => (await execFile("git", args, { cwd })).stdout;

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "git-gate-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const origin = path.join(root, "origin"), agent = path.join(root, "agent");
	const live = path.join(agent, "git/github.com/fixture/repo");
	await mkdir(origin); await mkdir(path.dirname(live), { recursive: true });
	await git(["init", "-b", "main"], origin);
	await git(["config", "user.email", "test@example.invalid"], origin);
	await git(["config", "user.name", "Fixture"], origin);
	await writeFile(path.join(origin, "package.json"), '{"name":"fixture","version":"1.0.0"}');
	await writeFile(path.join(origin, "README.md"), "original\n");
	await git(["add", "."], origin); await git(["commit", "-m", "baseline"], origin);
	await git(["clone", origin, live], root);
	await writeFile(path.join(origin, "README.md"), "reviewed candidate\n");
	await git(["commit", "-am", "candidate"], origin);
	await writeFile(path.join(agent, "settings.json"), '{"packages":["git:github.com/fixture/repo"]}');
	const marker = path.join(root, "HOOK_RAN");
	const calls = [];
	const runner = async (command, args, cwd, signal) => {
		calls.push({ command, args, cwd });
		if (command === "git" && args[0] === "clone") {
			// Substitute a local, controlled remote only in this test; production accepts public HTTPS GitHub.
			const destination = args.at(-1);
			await execFile("git", ["clone", "--no-local", "--single-branch", "--no-checkout", origin, destination], { cwd });
			const hook = path.join(destination, ".git/hooks/post-checkout");
			await writeFile(hook, "#!/bin/sh\necho unsafe > '" + marker + "'\n");
			await chmod(hook, 0o755);
			return { code: 0, stdout: "", stderr: "" };
		}
		return run(command, args, cwd, signal);
	};
	return { origin, agent, live, calls, marker, options: { agentDir: agent, runner,
		signal: new AbortController().signal, reviewer: async (payload, digest) => {
			assert.ok(JSON.parse(payload).changes.some((change) => change.path === "README.md"));
			return { schemaVersion: 1, candidate: digest, decision: "approve", complete: true, findings: [], reason: "Test fixture" };
		},
	} };
}

test("real Git fast-forward staging promotes reviewed source without running checkout hooks", { skip }, async (t) => {
	const f = await fixture(t);
	const { report } = await runSecurityUpdates(f.options);
	assert.equal(report.results[0].status, "updated", JSON.stringify(report));
	assert.equal(await readFile(path.join(f.live, "README.md"), "utf8"), "reviewed candidate\n");
	assert.equal((await git(["config", "--local", "core.hooksPath"], f.live)).trim(), "/dev/null");
	await assert.rejects(access(f.marker), { code: "ENOENT" });
	assert.ok(f.calls.every((call) => call.command === "git"), "No dependency installer for a repo without runtime dependencies");
});

test("dirty Git checkout is not overwritten", { skip }, async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.live, "README.md"), "my local work");
	const { report } = await runSecurityUpdates(f.options);
	assert.equal(report.results[0].status, "blocked");
	assert.match(report.results[0].reason, /local changes/);
	assert.equal(await readFile(path.join(f.live, "README.md"), "utf8"), "my local work");
	assert.ok(!f.calls.some((call) => call.args[0] === "clone"));
});

test("Git force-push/non-fast-forward is not automatically accepted", { skip }, async (t) => {
	const f = await fixture(t);
	await git(["checkout", "--orphan", "replacement"], f.origin);
	await git(["add", "."], f.origin); await git(["commit", "-m", "unrelated root"], f.origin);
	await git(["branch", "-M", "main"], f.origin);
	const { report } = await runSecurityUpdates(f.options);
	assert.equal(report.results[0].status, "blocked");
	assert.equal(await readFile(path.join(f.live, "README.md"), "utf8"), "original\n");
});

test("Git runtime dependencies without a verifiable lock are blocked", { skip }, async (t) => {
	const f = await fixture(t);
	await writeFile(path.join(f.origin, "package.json"), '{"name":"fixture","version":"2","dependencies":{"is-number":"*"}}');
	await git(["commit", "-am", "requires locked dependencies"], f.origin);
	const { report } = await runSecurityUpdates(f.options);
	assert.equal(report.results[0].status, "blocked");
	assert.ok(f.calls.every((call) => call.command === "git"), "No unpinned dependency installation");
});
