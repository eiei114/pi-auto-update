import { cp, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { run, type Runner } from "./process.ts";
import type { Reviewer } from "./review.ts";
import { reviewChangeSet, type ReviewEvidence } from "./batches.ts";
import { planTargets, stageTarget, type Target } from "./targets.ts";
import { changes, hash, snapshot } from "./tree.ts";
import { parseAutoUpdateSettings } from "./settings.ts";

export type UpdateReport = {
	started: string;
	reviewModel?: string;
	notices: string[];
	results: { target: string; status: "updated" | "unchanged" | "blocked"; reason?: string;
		baseline?: string; candidate?: string; verdict?: unknown; review?: ReviewEvidence; backup?: string }[];
};
export type GateOptions = {
	agentDir: string; reviewer: Reviewer; signal: AbortSignal;
	runner?: Runner; platform?: NodeJS.Platform; status?: (message: string) => void;
	/** Populated only from the same personal settings snapshot bound to this run. */
	reviewModel?: string;
};
export const safeMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
	.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);

async function assertManagedPath(agent: string, live: string): Promise<void> {
	if (!live.startsWith(agent + path.sep)) throw new Error("Invalid managed target");
	// Do not traverse symlinked parents (including npm/node_modules roots).
	let current = agent;
	for (const part of path.relative(agent, live).split(path.sep)) {
		current = path.join(current, part);
		if (!(await lstat(current)).isDirectory()) throw new Error("Managed package path must be a real directory");
	}
}

async function secureDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if (!(await lstat(dir)).isDirectory()) throw new Error("Security state path must be a real directory");
}

/** Only promote the frozen directory that was reviewed. No resolver/install command after approval. */
export async function updateTarget(target: Target, work: string, options: GateOptions): Promise<UpdateReport["results"][number]> {
	const { signal, reviewer } = options;
	const runner = options.runner ?? run;
	const result: UpdateReport["results"][number] = { target: target.label, status: "blocked" };
	const stage = path.join(work, "candidate");
	const frozen = path.join(work, "approved");
	try {
		await assertManagedPath(options.agentDir, target.live);
		options.status?.("Staging " + target.label);
		const baseline = await snapshot(target.live);
		result.baseline = baseline.digest;
		await stageTarget(target, stage, baseline, runner, signal);
		const candidate = await snapshot(stage);
		// Changes in an existing checkout during resolution are not implicitly approved.
		if ((await snapshot(target.live)).digest !== baseline.digest) throw new Error("Installed files changed while staging");
		const diff = changes(baseline, candidate);
		if (!diff.length) { result.status = "unchanged"; return result; }
		result.candidate = candidate.digest;
		// Freeze separately without rewriting relative npm .bin links into absolute staging paths.
		await cp(stage, frozen, { recursive: true, dereference: false, verbatimSymlinks: true });
		const physical = await snapshot(frozen, true);
		if ((await snapshot(frozen)).digest !== candidate.digest) throw new Error("Staged files changed while freezing");
		const livePhysical = await snapshot(target.live, true);
		options.status?.("Security review: " + target.label);
		signal.throwIfAborted();
		result.verdict = await reviewChangeSet(target.label, baseline, candidate, reviewer, signal, options.reviewModel,
			(evidence) => { result.review = evidence; });
		signal.throwIfAborted();
		if ((await snapshot(frozen, true)).digest !== physical.digest) throw new Error("Reviewed candidate changed; approval invalidated");
		if ((await snapshot(target.live, true)).digest !== livePhysical.digest ||
			(await snapshot(target.live)).digest !== baseline.digest) throw new Error("Installed files changed; approval invalidated");
		if (hash(await readFile(path.join(options.agentDir, "settings.json"))) !== await readFile(path.join(work, "settings-hash"), "utf8")) {
			throw new Error("Package settings changed; approval invalidated");
		}
		// Same-filesystem rename with rollback. Keep the old tree for explicit recovery.
		const backup = path.join(work, "backup");
		const journal = path.join(work, "promotion.json");
		const journalData = { target: target.label, live: target.live, backup, candidate: candidate.digest };
		await writeFile(journal, JSON.stringify({ ...journalData, phase: "prepared" }), { mode: 0o600, flag: "wx" });
		signal.throwIfAborted();
		await rename(target.live, backup);
		try { await rename(frozen, target.live); }
		catch (error) { await rename(backup, target.live); throw error; }
		result.status = "updated";
		result.backup = backup;
		await writeFile(journal, JSON.stringify({ ...journalData, phase: "promoted" }), { mode: 0o600 });
	} catch (error) {
		result.reason = safeMessage(error);
	} finally {
		await rm(stage, { recursive: true, force: true });
		await rm(frozen, { recursive: true, force: true });
	}
	return result;
}

export async function runSecurityUpdates(options: GateOptions): Promise<{ report: UpdateReport; reportPath: string }> {
	const agent = await realpath(options.agentDir);
	options = { ...options, agentDir: agent };
	const lockPath = path.join(agent, ".auto-update-security.lock");
	// Cross-process lock; never steal a stale lock automatically after a crash.
	const lock = await open(lockPath, "wx", 0o600);
	const state = path.join(agent, "auto-update-security");
	let runDir: string | undefined;
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
		await secureDirectory(state);
		const reports = path.join(state, "reports");
		await secureDirectory(reports);
		runDir = path.join(state, randomUUID());
		await mkdir(runDir, { mode: 0o700 });
		const settingsBytes = await readFile(path.join(agent, "settings.json"));
		const settings = JSON.parse(settingsBytes.toString("utf8"));
		const plan = planTargets(agent, settings);
		options = { ...options, reviewModel: parseAutoUpdateSettings(settings.autoUpdate).reviewModel };
		const report: UpdateReport = { started: new Date().toISOString(), reviewModel: options.reviewModel ?? "current", notices: plan.notices, results: [] };
		if (plan.targets.length && (options.platform ?? process.platform) === "win32") {
			throw new Error("Windows automatic promotion is deferred while Pi may hold package files open");
		}
		for (const [index, target] of plan.targets.entries()) {
			if (options.signal.aborted) {
				report.results.push({ target: target.label, status: "blocked", reason: "Update cancelled" });
				continue;
			}
			const work = path.join(runDir, String(index));
			await mkdir(work, { mode: 0o700 });
			await writeFile(path.join(work, "settings-hash"), hash(settingsBytes), { mode: 0o600, flag: "wx" });
			report.results.push(await updateTarget(target, work, options));
		}
		const reportPath = path.join(reports, path.basename(runDir) + ".json");
		await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
		return { report, reportPath };
	} finally {
		await lock.close();
		await rm(lockPath);
		// Backups intentionally survive; candidates are removed by updateTarget.
	}
}
