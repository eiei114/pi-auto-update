import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;
const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const { DefaultResourceLoader } = await import(new URL("./core/resource-loader.js", piEntryUrl));

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

async function run(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
		shell: options.shell ?? false,
		windowsHide: true,
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	return await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code !== 0) {
				reject(
					new Error(
						`${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}\n${stdout}\n${stderr}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function runNpm(args, options = {}) {
	const invocation = npmInvocation(args);
	return await run(invocation.command, invocation.args, { ...options, shell: invocation.shell });
}

async function packPackage(packDir) {
	const { stdout } = await runNpm(["pack", "--json", "--pack-destination", packDir], {
		cwd: repoRoot,
	});
	const packed = JSON.parse(stdout);
	assert.equal(packed.length, 1);
	const tarballPath = path.join(packDir, packed[0].filename);
	await access(tarballPath);
	return tarballPath;
}

async function installPackedPackage(agentDir, tarballPath) {
	const npmRoot = path.join(agentDir, "npm");
	await mkdir(npmRoot, { recursive: true });
	await writeFile(
		path.join(npmRoot, "package.json"),
		`${JSON.stringify({ name: "pi-extensions", private: true }, null, 2)}\n`,
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
		{ cwd: repoRoot },
	);
	return path.join(npmRoot, "node_modules", packageName);
}

async function createFakePiBin(rootDir) {
	const binDir = path.join(rootDir, "bin");
	const logPath = path.join(rootDir, "pi-invocations.log");
	await mkdir(binDir, { recursive: true });

	if (process.platform === "win32") {
		await writeFile(
			path.join(binDir, "pi.cmd"),
			`@echo off\r\necho %*>>"${logPath}"\r\nexit /b 0\r\n`,
			"utf8",
		);
	} else {
		const quotedLogPath = logPath.replaceAll("'", "'\\''");
		const executable = path.join(binDir, "pi");
		await writeFile(
			executable,
			`#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> '${quotedLogPath}'\nexit 0\n`,
			"utf8",
		);
		await chmod(executable, 0o755);
	}

	return { binDir, logPath };
}

async function readOptional(filePath) {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw error;
	}
}

function findPackageExtension(extensions, installedPackageDir) {
	return extensions.find((extension) => {
		const relativePath = path.relative(installedPackageDir, extension.resolvedPath);
		return relativePath.split(path.sep).join("/") === "extensions/auto-update.ts";
	});
}

test("loads the packed Pi package in an isolated offline startup smoke", async () => {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-auto-update-smoke-"));
	const originalOffline = process.env.PI_OFFLINE;
	const originalPath = process.env.PATH;

	try {
		const agentDir = path.join(tempRoot, "agent");
		const projectDir = path.join(tempRoot, "project");
		const packDir = path.join(tempRoot, "pack");
		await mkdir(agentDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await mkdir(packDir, { recursive: true });

		const tarballPath = await packPackage(packDir);
		const installedPackageDir = await installPackedPackage(agentDir, tarballPath);
		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ packages: [`npm:${packageName}@${packageJson.version}`] }, null, 2)}\n`,
			"utf8",
		);
		const { binDir, logPath } = await createFakePiBin(tempRoot);

		process.env.PI_OFFLINE = "1";
		process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);

		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });
		await loader.reload();

		const loadResult = loader.getExtensions();
		assert.deepEqual(loadResult.errors, []);
		assert.equal(loadResult.extensions.length, 1);

		const extension = findPackageExtension(loadResult.extensions, installedPackageDir);
		assert.ok(extension, "expected the extension to load from the installed package tarball");
		assert.equal(extension.handlers.get("session_start")?.length, 1);
		assert.equal(typeof extension.commands.get("auto-update-now")?.handler, "function");

		const notifications = [];
		const statuses = [];
		const ctx = {
			cwd: projectDir,
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

		await extension.handlers.get("session_start")[0]({ reason: "startup" }, ctx);
		assert.deepEqual(statuses, []);
		assert.deepEqual(notifications.at(-1), ["Pi auto-update skipped: offline mode", "info"]);
		assert.equal(await readOptional(logPath), "", "offline startup must not invoke pi update");

		await loader.reload();
		const reloadedExtension = findPackageExtension(loader.getExtensions().extensions, installedPackageDir);
		assert.ok(reloadedExtension, "expected the installed package extension after /reload-equivalent reload");
		await reloadedExtension.handlers.get("session_start")[0]({ reason: "reload" }, ctx);
		assert.equal(await readOptional(logPath), "", "/reload session_start must not duplicate startup updates");
		assert.equal(notifications.length, 1);
	} finally {
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(tempRoot, { recursive: true, force: true });
	}
});
