import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXPECTED_SDK_VERSIONS,
	EXTENSION_LOAD_ERROR_PATTERN,
	behaviorAssertions,
	parseJsonLines,
	SDK_NAMES,
	UNHANDLED_ERROR_PATTERN,
	VERIFICATION_CONTRACT,
} from "./pi-sdk-smoke-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const reportPath = path.join(root, "docs", "verification", "pi-sdk-smoke.json");
const SHORT_PROBE_TIMEOUT_MS = 15_000;
const CLEANUP_GRACE_MS = 1_000;
const INSTALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

function resolveReviewedHeadSha() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
	});
	const head = result.stdout?.trim();
	if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(head ?? "")) {
		throw new Error(`git rev-parse HEAD failed: ${(result.stderr || result.stdout || "").trim()}`);
	}
	return head;
}

function npmInvocation(args) {
	if (process.env.npm_execpath) {
		return { command: process.execPath, args: [process.env.npm_execpath, ...args], shell: false };
	}
	return {
		command: process.platform === "win32" ? "npm.cmd" : "npm",
		args,
		shell: process.platform === "win32",
	};
}

function terminateOwnedTree(child) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		spawnSync(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 700,
		});
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// The owned process may already have exited.
		}
	}
}

function runProcess(command, args, options = {}) {
	const timeoutMs = options.timeoutMs ?? SHORT_PROBE_TIMEOUT_MS;
	const cleanupGraceMs = options.cleanupGraceMs ?? CLEANUP_GRACE_MS;
	const encoding = "utf8";

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let timedOut = false;
		let outputLimitExceeded = false;
		let processError;
		let processExited = false;
		let settled = false;
		let timeoutHandle;
		let cleanupHandle;
		const waiters = new Set();
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			encoding,
			shell: options.shell ?? false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const finish = (status, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);
			clearTimeout(cleanupHandle);
			resolve({
				status,
				signal,
				stdout,
				stderr,
				error: processError,
				processExited,
				timedOut,
				outputLimitExceeded,
				durationMs: Date.now() - startedAt,
			});
		};

		child.stdout.setEncoding(encoding);
		child.stderr.setEncoding(encoding);
		const currentRecords = () => parseJsonLines(stdout);
		const checkWaiters = () => {
			for (const waiter of waiters) {
				try {
					if (waiter.predicate(currentRecords())) {
						waiters.delete(waiter);
						waiter.resolve(currentRecords());
					}
				} catch (error) {
					waiters.delete(waiter);
					waiter.reject(error);
				}
			}
		};
		const rejectWaiters = (error) => {
			for (const waiter of waiters) waiter.reject(error);
			waiters.clear();
		};
		const waitForRecords = (predicate) => new Promise((resolve, reject) => {
			const current = currentRecords();
			if (predicate(current)) {
				resolve(current);
				return;
			}
			waiters.add({ predicate, resolve, reject });
		});
		const sendRecords = (records) => {
			for (const record of records) child.stdin.write(`${JSON.stringify(record)}\n`);
		};
		const collect = (target) => (chunk) => {
			outputBytes += Buffer.byteLength(chunk, encoding);
			if (outputBytes <= MAX_OUTPUT_BYTES) {
				if (target === "stdout") {
					stdout += chunk;
					checkWaiters();
				} else stderr += chunk;
			} else if (!outputLimitExceeded) {
				outputLimitExceeded = true;
				timedOut = true;
				rejectWaiters(new Error(`Output exceeded ${MAX_OUTPUT_BYTES} bytes`));
				terminateOwnedTree(child);
			}
		};
		child.stdout.on("data", collect("stdout"));
		child.stderr.on("data", collect("stderr"));
		child.on("error", (error) => {
			processError = error;
		});
		child.on("close", (status, signal) => {
			processExited = true;
			rejectWaiters(new Error(`Process exited before the expected RPC response (status=${status})`));
			queueMicrotask(() => finish(status, signal));
		});
		child.stdin.on("error", () => {
			// A process that exits before consuming its bounded input is reported by close/status.
		});
		if (options.interact) {
			Promise.resolve()
				.then(() => options.interact({ sendRecords, waitForRecords }))
				.then(() => child.stdin.end(), (error) => {
					processError = error;
					child.stdin.end();
				});
		} else {
			child.stdin.end(options.input ?? "");
		}

		timeoutHandle = setTimeout(() => {
			timedOut = true;
			const cleanupDeadline = Date.now() + cleanupGraceMs;
			rejectWaiters(new Error(`Process exceeded its ${timeoutMs}ms deadline`));
			terminateOwnedTree(child);
			cleanupHandle = setTimeout(() => finish(null, "cleanup-deadline"), Math.max(1, cleanupDeadline - Date.now()));
		}, timeoutMs);
	});
}

function requireSuccess(label, result) {
	if (result.status !== 0 || result.error || result.timedOut || result.outputLimitExceeded || !result.processExited) {
		throw new Error(
			`${label} failed (status=${result.status}, timeout=${result.timedOut}, exited=${result.processExited}):\n${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
		);
	}
}

async function runNpm(args, options = {}) {
	const invocation = npmInvocation(args);
	const result = await runProcess(invocation.command, invocation.args, {
		cwd: options.cwd ?? root,
		env: options.env,
		shell: invocation.shell,
		timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
	});
	requireSuccess(`npm ${args.join(" ")}`, result);
	return result;
}

async function packPackage(packDir) {
	const result = await runNpm(["pack", "--json", "--pack-destination", packDir]);
	const packed = JSON.parse(result.stdout);
	assert.equal(packed.length, 1, "npm pack should produce exactly one package archive");
	const tarballPath = path.join(packDir, packed[0].filename);
	await readFile(tarballPath);
	return tarballPath;
}

async function installPackedPackage(npmRoot, tarballPath, packageName) {
	await mkdir(npmRoot, { recursive: true });
	await writeFile(
		path.join(npmRoot, "package.json"),
		`${JSON.stringify({ name: "pi-auto-update-smoke", private: true }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(path.join(npmRoot, ".gitignore"), "*\n!.gitignore\n", "utf8");
	await runNpm(
		[
			"install",
			tarballPath,
			"--prefix",
			npmRoot,
			"--legacy-peer-deps",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
		],
		{ timeoutMs: INSTALL_TIMEOUT_MS },
	);
	const packageDir = path.join(npmRoot, "node_modules", packageName);
	await readFile(path.join(packageDir, "extensions", "auto-update.ts"));
	return packageDir;
}

function setPath(env, value) {
	const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
	env[key] = value;
}

function isolatedEnv({ agentDir, tempRoot, sdkBin, updaterBin, updaterLog, missingUpdater = false }) {
	const env = { ...process.env };
	delete env.PI_OFFLINE;
	delete env.PI_INTERCOM_SESSION_ID;
	env.PI_CODING_AGENT_DIR = agentDir;
	env.PI_AUTO_UPDATE = "0";
	env.npm_config_prefix = path.join(tempRoot, "npm-global");
	env.npm_config_cache = path.join(tempRoot, "npm-cache");
	if (updaterLog) env.PI_AUTO_UPDATE_SMOKE_LOG = updaterLog;
	if (missingUpdater) env.PI_OFFLINE = "1"; // Explicit fail-closed manual invocation probe.
	setPath(env, missingUpdater
		? path.join(tempRoot, "empty-bin")
		: [updaterBin, sdkBin, process.env.PATH].filter(Boolean).join(path.delimiter));
	return env;
}

function redactText(value, tempRoot) {
	const escapedTempRoot = JSON.stringify(tempRoot).slice(1, -1);
	return value.replaceAll(tempRoot, "<isolated-temp>").replaceAll(escapedTempRoot, "<isolated-temp>");
}

function redactValue(value, tempRoot) {
	if (typeof value === "string") return redactText(value, tempRoot);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, tempRoot));
	if (value && typeof value === "object") {
		const entries = Object.entries(value).filter(([key]) => !(key === "id" && value.type === "extension_ui_request"));
		return Object.fromEntries(entries.map(([key, item]) => [key, redactValue(item, tempRoot)]));
	}
	return value;
}

function capturedOutput(stdout, stderr, error, tempRoot) {
	const records = parseJsonLines(stdout);
	const stableStdout = records.length > 0
		? records.map((record) => JSON.stringify(redactValue(record, tempRoot))).join("\n")
		: stdout;
	return redactText(`${stableStdout}\n${stderr}\n${error?.message ?? ""}`, tempRoot);
}

function describeProcess(name, command, result, extraAssertions = []) {
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const fullOutput = `${stdout}\n${stderr}\n${result.error?.message ?? ""}`;
	const exit_code = result.status ?? 1;
	const responses = parseJsonLines(stdout);
	const assertions = [...behaviorAssertions(name, {
		responses,
		updaterInvocations: command.updaterInvocations ?? [],
		stdout,
		stderr,
		exit_code,
		processExited: result.processExited,
		timedOut: result.timedOut,
		expectedVersion: command.expectedVersion,
	}), ...extraAssertions];
	const hasUnhandledError = UNHANDLED_ERROR_PATTERN.test(fullOutput);
	const hasLoadError = EXTENSION_LOAD_ERROR_PATTERN.test(fullOutput);
	const passed = result.status === 0 && result.processExited && !result.timedOut && !result.outputLimitExceeded &&
		!result.error && !hasUnhandledError && !hasLoadError && assertions.every((item) => item.passed);
	const redacted = capturedOutput(stdout, stderr, result.error, command.tempRoot);
	return {
		name,
		command: command.description,
		exit_code,
		passed,
		evidence: redacted.slice(-8_000) || result.error?.message || "No process output captured",
		assertions: redactValue(assertions, command.tempRoot),
		hasUnhandledError,
		hasLoadError,
	};
}

async function createUpdaterShim(updaterBin) {
	await mkdir(updaterBin, { recursive: true });
	if (process.platform === "win32") {
		await writeFile(
			path.join(updaterBin, "pi.cmd"),
			["@echo off", `>>"%PI_AUTO_UPDATE_SMOKE_LOG%" echo %*`, "exit /b 0", ""].join("\r\n"),
			"utf8",
		);
		return;
	}
	const shimPath = path.join(updaterBin, "pi");
	await writeFile(shimPath, ["#!/bin/sh", `printf '%s\\n' "$*" >> "$PI_AUTO_UPDATE_SMOKE_LOG"`, ""].join("\n"), "utf8");
	await chmod(shimPath, 0o755);
}

function createRpcRunner({ piCli, extensionEntry, agentDir, projectDir, tempRoot, sdkBin, updaterBin }) {
	const args = [
		piCli,
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-mcp",
		"-e",
		extensionEntry,
		"--mode",
		"rpc",
	];
	let invocation = 0;
	const run = async (includeFeature, missingUpdater = false) => {
		const updaterLog = path.join(tempRoot, `updater-invocations-${invocation++}.log`);
		const result = await runProcess(process.execPath, args, {
			cwd: projectDir,
			env: isolatedEnv({ agentDir, tempRoot, sdkBin, updaterBin, updaterLog, missingUpdater }),
			timeoutMs: SHORT_PROBE_TIMEOUT_MS,
			cleanupGraceMs: CLEANUP_GRACE_MS,
			interact: async ({ sendRecords, waitForRecords }) => {
				sendRecords([{ id: "inventory", type: "get_commands" }]);
				await waitForRecords((responses) => responses.some((row) =>
					row?.id === "inventory" && row.command === "get_commands" && row.success === true,
				));
				if (!includeFeature) return;

				sendRecords([{ id: "feature", type: "prompt", message: "/auto-update-now" }]);
				await waitForRecords((responses) => {
					const prompt = responses.find((row) => row?.id === "feature" && row.command === "prompt");
					const finished = responses.some((row) => row?.type === "extension_ui_request" && row.method === "notify" &&
						typeof row.message === "string" &&
						(row.message.startsWith("Pi security update completed:") || row.message.startsWith("Pi security update blocked:")),
					);
					return prompt?.success === true && prompt.data?.disposition === "handled" && finished;
				});
			},
		});
		try {
			result.updaterInvocations = (await readFile(updaterLog, "utf8")).split(/\r?\n/).filter(Boolean);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			result.updaterInvocations = [];
		}
		return result;
	};
	return { run, args };
}

async function runNativeShell({ sdkBin, projectDir, agentDir, tempRoot, expectedVersion }) {
	const env = isolatedEnv({ agentDir, tempRoot, sdkBin });
	if (process.platform === "win32") {
		const shell = env.ComSpec ?? env.COMSPEC ?? path.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
		return runProcess(shell, ["/d", "/s", "/c", "pi --version"], {
			cwd: projectDir,
			env,
			timeoutMs: SHORT_PROBE_TIMEOUT_MS,
			cleanupGraceMs: CLEANUP_GRACE_MS,
		});
	}
	return runProcess("/bin/sh", ["-c", "pi --version"], {
		cwd: projectDir,
		env,
		timeoutMs: SHORT_PROBE_TIMEOUT_MS,
		cleanupGraceMs: CLEANUP_GRACE_MS,
	});
}

async function main() {
	const manifest = await readJson(path.join(root, "package.json"));
	const lockfile = await readJson(path.join(root, "package-lock.json"));
	const sdkVersions = {};
	for (const name of SDK_NAMES) {
		const installed = await readJson(path.join(root, "node_modules", name, "package.json"));
		assert.equal(manifest.devDependencies?.[name], EXPECTED_SDK_VERSIONS[name], `manifest pin for ${name}`);
		assert.equal(lockfile.packages?.[""]?.devDependencies?.[name], EXPECTED_SDK_VERSIONS[name], `lockfile pin for ${name}`);
		assert.equal(installed.version, EXPECTED_SDK_VERSIONS[name], `installed version for ${name}`);
		sdkVersions[name] = installed.version;
	}

	const piManifest = await readJson(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
	const piCli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", piManifest.bin.pi);
	const sdkBin = path.join(root, "node_modules", ".bin");
	const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-auto-update sdk smoke "));
	const agentDir = path.join(tempRoot, "agent");
	const npmRoot = path.join(agentDir, "npm");
	const projectDir = path.join(tempRoot, "project");
	const packDir = path.join(tempRoot, "pack");
	const emptyBin = path.join(tempRoot, "empty-bin");
	const updaterBin = path.join(tempRoot, "updater-bin");
	await Promise.all([agentDir, projectDir, packDir, emptyBin, updaterBin].map((directory) => mkdir(directory, { recursive: true })));
	await createUpdaterShim(updaterBin);
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
	const tarballPath = await packPackage(packDir);
	const packageDir = await installPackedPackage(npmRoot, tarballPath, manifest.name);
	const extensionEntry = path.join(packageDir, "extensions", "auto-update.ts");
	const rpc = createRpcRunner({ piCli, extensionEntry, agentDir, projectDir, tempRoot, sdkBin, updaterBin });
	const commandMeta = { description: "npm run smoke:pi", tempRoot };
	const cases = [];

	try {
		const extensionLoad = await rpc.run(false);
		cases.push(describeProcess("extension_load", commandMeta, extensionLoad));

		const happyPath = await rpc.run(true);
		cases.push(describeProcess("happy_path", { ...commandMeta, updaterInvocations: happyPath.updaterInvocations }, happyPath));

		const errorPath = await rpc.run(true, true);
		cases.push(describeProcess("error_path", commandMeta, errorPath));

		const firstProcess = await rpc.run(false);
		const secondProcess = await rpc.run(true);
		const secondResult = describeProcess("reload_cleanup", {
			...commandMeta,
			updaterInvocations: secondProcess.updaterInvocations,
		}, secondProcess);
		const bothProcessesExitedCleanly = firstProcess.status === 0 && firstProcess.processExited &&
			!firstProcess.timedOut && secondProcess.status === 0 && secondProcess.processExited && !secondProcess.timedOut;
		const cleanShutdown = secondResult.assertions.find((item) => item.id === "clean_shutdown");
		cleanShutdown.observed.first_process = {
			exit_code: firstProcess.status,
			processExited: firstProcess.processExited,
			timedOut: firstProcess.timedOut,
		};
		cleanShutdown.passed = cleanShutdown.passed && bothProcessesExitedCleanly;
		secondResult.passed = secondResult.passed && bothProcessesExitedCleanly;
		secondResult.evidence = [
			"First actual Pi process:",
			capturedOutput(firstProcess.stdout, firstProcess.stderr, firstProcess.error, tempRoot),
			"Second actual Pi process:",
			secondResult.evidence,
		].join("\n").slice(-8_000);
		secondResult.hasUnhandledError ||= UNHANDLED_ERROR_PATTERN.test(`${firstProcess.stdout}\n${firstProcess.stderr}`);
		secondResult.hasLoadError ||= EXTENSION_LOAD_ERROR_PATTERN.test(`${firstProcess.stdout}\n${firstProcess.stderr}`);
		cases.push(secondResult);

		const hostShell = await runNativeShell({ sdkBin, projectDir, agentDir, tempRoot, expectedVersion: sdkVersions["@earendil-works/pi-coding-agent"] });
		cases.push(describeProcess("host_shell", {
			...commandMeta,
			expectedVersion: sdkVersions["@earendil-works/pi-coding-agent"],
		}, hostShell));

		const report = {
			schema_version: 1,
			verification_contract: VERIFICATION_CONTRACT,
			sdk_versions: sdkVersions,
			platform: process.platform,
			head_sha: resolveReviewedHeadSha(),
			node_version: process.version,
			model_inference: "none; actual Pi CLI/RPC and package extension lifecycle, with an isolated empty Pi agent directory",
			unhandled_errors: cases.filter((item) => item.hasUnhandledError).length,
			extension_load_errors: cases.filter((item) => item.hasLoadError || (item.name === "extension_load" && !item.passed)).length,
			cases: cases.map(({ hasUnhandledError, hasLoadError, ...item }) => item),
		};
		await mkdir(path.dirname(reportPath), { recursive: true });
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(JSON.stringify({
			verification_contract: VERIFICATION_CONTRACT,
			platform: process.platform,
			cases: cases.map(({ name, passed, exit_code }) => ({ name, passed, exit_code })),
		}));
		if (cases.some((item) => !item.passed) || report.unhandled_errors !== 0 || report.extension_load_errors !== 0) {
			process.exitCode = 1;
		}
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

await main();
