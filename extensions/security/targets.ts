import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checked, npm, npmArgs, type Runner } from "./process.ts";
import { snapshot, type Snapshot } from "./tree.ts";

const REGISTRY = "https://registry.npmjs.org";
const NPM_SAFE = ["--ignore-scripts", "--legacy-peer-deps", "--no-fund", "--registry=" + REGISTRY,
	"--globalconfig=/dev/null", "--git=/usr/bin/false", "--script-shell=/usr/bin/false"];
const safeNpmArgs = (stage: string) => [...NPM_SAFE, "--userconfig=" + path.join(path.dirname(stage), "empty.npmrc")];
const NAME = "(?:@[a-z0-9_~-]+/)?[a-z0-9_~][a-z0-9._~-]*";
export type Target = { label: string; live: string; kind: "npm" | "git"; specs?: string[]; repo?: string };
type Json = Record<string, any>;

export async function readJson(file: string): Promise<Json> {
	return JSON.parse(await readFile(file, "utf8"));
}

export function planTargets(agentDir: string, settings: Json): { targets: Target[]; notices: string[] } {
	const notices = ["Pi core and project-local packages deferred: no verified promotion adapter"];
	const specs: string[] = [];
	const targets: Target[] = [];
	if (settings.npmCommand && JSON.stringify(settings.npmCommand) !== '["npm"]') {
		throw new Error("Custom npm/pnpm/Bun commands are unsupported; no updates applied");
	}
	if (settings.packages !== undefined && !Array.isArray(settings.packages)) throw new Error("Invalid personal packages setting");
	for (const entry of settings.packages ?? []) {
		const source = typeof entry === "string" ? entry : entry?.source;
		if (typeof source !== "string") throw new Error("Invalid package source");
		const match = source.match(new RegExp("^npm:(" + NAME + ")(@[^\\s]+)?$"));
		if (match) {
			if (match[2]) notices.push(`${source}: version/tag/range left unchanged`);
			else specs.push(match[1] + "@latest");
			continue;
		}
		const git = source.match(/^(?:git:github\.com\/|https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@(.+))?$/);
		if (git && ![".", ".."].includes(git[2])) {
			if (git[3]) { notices.push(`${source}: configured git ref left unchanged`); continue; }
			const repoPath = git[1] + "/" + git[2];
			targets.push({ label: source, live: path.join(agentDir, "git", "github.com", repoPath),
				kind: "git", repo: "https://github.com/" + repoPath + ".git" });
		} else notices.push("A local or unsupported source was left unchanged");
	}
	if (specs.length) targets.unshift({ label: "personal npm packages", kind: "npm", live: path.join(agentDir, "npm"),
		specs: [...new Set(specs)] });
	return { targets: targets.filter((target, i, all) => all.findIndex((other) => other.live === target.live) === i), notices };
}

/** Reject git/file/alias dependencies BEFORE npm ci, including all transitive lock entries. */
export function validateLock(lock: Json): void {
	if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages) ||
		!lock.packages[""] || typeof lock.packages[""] !== "object") throw new Error("A complete npm v2/v3 lockfile is required");
	for (const [name, entry] of Object.entries(lock.packages) as [string, Json][]) {
		if (name === "") continue;
		if (!/^node_modules\//.test(name) || name.split("/").some((part) => part === ".." || part === ".") ||
			!entry || typeof entry !== "object" || entry.link || entry.inBundle || typeof entry.version !== "string" ||
			typeof entry.resolved !== "string" || typeof entry.integrity !== "string" ||
			!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) throw new Error("Unverifiable dependency in lockfile: " + name.slice(0, 200));
		const url = new URL(entry.resolved);
		if (url.origin !== REGISTRY || url.username || url.password || !url.pathname.endsWith(".tgz") || url.search || url.hash) {
			throw new Error("Only integrity-pinned public npm registry tarballs are supported");
		}
	}
}

export function validateManifest(manifest: Json): void {
	for (const field of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
		if (manifest[field] === undefined) continue;
		if (!manifest[field] || typeof manifest[field] !== "object" || Array.isArray(manifest[field])) throw new Error("Invalid dependencies");
		for (const [name, spec] of Object.entries(manifest[field])) {
			if (!new RegExp("^" + NAME + "$").test(name) || typeof spec !== "string" ||
				!spec || !/^[a-zA-Z0-9.*^~<>=|+ -]+$/.test(spec)) throw new Error("Non-registry dependency requires manual review");
		}
	}
	if (manifest.workspaces || manifest.bundledDependencies || manifest.bundleDependencies) throw new Error("Workspaces/bundled dependencies require manual review");
}

/** Bind advisory versions to actual installed manifests, not merely a claimed lockfile version. */
export async function validateInstalled(stage: string): Promise<void> {
	const lock = await readJson(path.join(stage, "package-lock.json"));
	const tree = await snapshot(stage); // Reject escaping symlinks before reading dependency manifests.
	for (const [name, entry] of Object.entries(lock.packages) as [string, Json][]) {
		if (!name) continue;
		const manifestFile = name + "/package.json";
		if (!tree.files.has(manifestFile)) {
			if (entry.dev || entry.optional || entry.peer) continue;
			throw new Error("Locked runtime dependency is missing from staged files");
		}
		const manifest = await readJson(path.join(stage, manifestFile));
		if (manifest.version !== entry.version || manifest.name !== name.split("node_modules/").at(-1)) {
			throw new Error("Installed dependency identity disagrees with audited lockfile");
		}
	}
	for (const name of tree.files.keys()) {
		if (/(^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name) &&
			!Object.hasOwn(lock.packages, name.slice(0, -"/package.json".length))) {
			throw new Error("Untracked/bundled dependency cannot be audited");
		}
	}
}

export function assertCleanAudit(result: { code: number; stdout: string }): void {
	const value = JSON.parse(result.stdout);
	const counts = value?.metadata?.vulnerabilities;
	const severities = ["info", "low", "moderate", "high", "critical", "total"];
	if (result.code !== 0 || value.error || !counts || severities.some((key) => counts[key] !== 0) ||
		!value.vulnerabilities || typeof value.vulnerabilities !== "object" || Array.isArray(value.vulnerabilities) ||
		Object.keys(value.vulnerabilities).length !== 0) throw new Error("Dependency audit found vulnerabilities or was incomplete");
}

export async function audit(runner: Runner, stage: string, signal: AbortSignal): Promise<void> {
	validateLock(await readJson(path.join(stage, "package-lock.json")));
	const [command, args] = npmArgs(["audit", "--json", "--omit=dev", ...safeNpmArgs(stage)]);
	assertCleanAudit(await runner(command, args, stage, signal));
}

/** Staging never imports candidate modules, runs their tests/builds, or permits lifecycle scripts. */
export async function stageTarget(target: Target, stage: string, baseline: Snapshot, runner: Runner, signal: AbortSignal): Promise<void> {
	await mkdir(stage, { mode: 0o700 });
	await writeFile(path.join(path.dirname(stage), "empty.npmrc"), "", { mode: 0o600, flag: "wx" });
	if (target.kind === "npm") {
		const extras = (await readdir(target.live)).filter((name) => !["package.json", "package-lock.json", ".gitignore", "node_modules"].includes(name));
		if (extras.length) throw new Error("Unexpected files in managed npm root; manual review required");
		for (const name of ["package.json", "package-lock.json"]) await cp(path.join(target.live, name), path.join(stage, name));
		if (baseline.files.has(".gitignore")) await cp(path.join(target.live, ".gitignore"), path.join(stage, ".gitignore"));
		validateManifest(await readJson(path.join(stage, "package.json")));
		validateLock(await readJson(path.join(stage, "package-lock.json")));
		await npm(runner, ["install", ...target.specs!, "--package-lock-only", ...safeNpmArgs(stage)], stage, signal);
	} else {
		if (!(await lstat(path.join(target.live, ".git"))).isDirectory()) throw new Error("Git worktrees/symlinked metadata require manual review");
		// Refuse dirty/untracked work and baseline attributes that could invoke a local clean filter.
		if ([...baseline.files.keys()].some((name) => /(^|\/)(\.gitattributes|\.gitmodules)$/.test(name))) {
			throw new Error("Git attributes/submodules require manual review");
		}
		const dirty = await checked(runner, "git", ["status", "--porcelain", "--untracked-files=all"], target.live, signal);
		if (dirty.trim()) throw new Error("Git checkout has local changes; manual review required");
		const tracked = new Set((await checked(runner, "git", ["ls-files", "-z"], target.live, signal)).split("\0"));
		if ([...baseline.files.keys()].some((name) => !name.startsWith("node_modules/") && !tracked.has(name))) {
			throw new Error("Git checkout has ignored local files; manual review required");
		}
		const oldHead = (await checked(runner, "git", ["rev-parse", "--verify", "HEAD"], target.live, signal)).trim();
		if (!/^[a-f0-9]{40,64}$/.test(oldHead)) throw new Error("Invalid git baseline");
		await rm(stage, { recursive: true });
		await checked(runner, "git", ["clone", "--single-branch", "--no-checkout", "--no-recurse-submodules", "--", target.repo!, stage], path.dirname(stage), signal);
		const branch = (await checked(runner, "git", ["symbolic-ref", "--short", "HEAD"], target.live, signal)).trim();
		const candidateBranch = (await checked(runner, "git", ["symbolic-ref", "--short", "HEAD"], stage, signal)).trim();
		if (branch !== candidateBranch) throw new Error("Non-default git branch requires manual review");
		await checked(runner, "git", ["merge-base", "--is-ancestor", oldHead, "HEAD"], stage, signal);
		const tree = await checked(runner, "git", ["ls-tree", "-r", "HEAD"], stage, signal);
		if (/^(120000|160000) /m.test(tree)) throw new Error("Git symlinks/submodules require manual review");
		await checked(runner, "git", ["config", "--local", "core.hooksPath", "/dev/null"], stage, signal);
		await checked(runner, "git", ["checkout", "--force", "HEAD"], stage, signal);
		// No project npm configuration, submodules, custom filters or build scripts.
		for (const blocked of [".gitmodules", ".npmrc", ".gitattributes"]) {
			try { await lstat(path.join(stage, blocked)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			throw new Error("Git submodules/custom attributes/npm configuration require manual review");
		}
		const manifest = await readJson(path.join(stage, "package.json"));
		validateManifest(manifest);
		if (!Object.keys(manifest.dependencies ?? {}).length && !Object.keys(manifest.optionalDependencies ?? {}).length) {
			// No runtime dependency tree to download/audit. Still review all source and manifest changes.
			return;
		}
	}
	validateManifest(await readJson(path.join(stage, "package.json")));
	validateLock(await readJson(path.join(stage, "package-lock.json")));
	await npm(runner, ["ci", "--omit=dev", ...safeNpmArgs(stage)], stage, signal);
	await validateInstalled(stage);
	await audit(runner, stage, signal);
}
