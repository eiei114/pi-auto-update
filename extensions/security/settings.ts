import { open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type AutoUpdateSettings = { reviewModel?: string };

/** Exact provider/model IDs only. Model IDs may themselves contain slashes. */
export function parseModelRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1 || ref.length > 512 ||
		!/^[a-zA-Z0-9._-]+$/.test(ref.slice(0, slash)) || /\s|[\x00-\x1f\x7f-\x9f]/.test(ref)) {
		throw new Error("Use an exact provider/model ID, for example openai-codex/gpt-6-luna");
	}
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function parseAutoUpdateSettings(value: unknown): AutoUpdateSettings {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value) ||
		Object.keys(value).some((key) => key !== "reviewModel")) throw new Error("Invalid personal autoUpdate settings");
	const ref = (value as Record<string, unknown>).reviewModel;
	if (ref === undefined || ref === "current") return {};
	if (typeof ref !== "string") throw new Error("autoUpdate.reviewModel must be a provider/model ID or current");
	parseModelRef(ref);
	return { reviewModel: ref };
}

export async function readAutoUpdateSettings(agentDir: string): Promise<AutoUpdateSettings> {
	const document = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
	return parseAutoUpdateSettings(document.autoUpdate);
}

/** Edit only the personal setting, preserving chat defaults and package/resource declarations. */
export async function writeReviewModel(agentDir: string, ref: string): Promise<void> {
	if (ref !== "current") parseModelRef(ref);
	const lockPath = path.join(agentDir, ".auto-update-security.lock");
	const lock = await open(lockPath, "wx", 0o600);
	const file = path.join(agentDir, "settings.json");
	const temp = path.join(agentDir, ".settings-auto-update-" + randomUUID() + ".tmp");
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid, action: "configure-review-model" }));
		const before = await readFile(file);
		const document = JSON.parse(before.toString("utf8"));
		if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Personal settings must be a JSON object");
		const config = parseAutoUpdateSettings(document.autoUpdate);
		document.autoUpdate = { ...config, reviewModel: ref };
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(document, null, 2) + "\n");
			await handle.sync();
		} finally { await handle.close(); }
		if (!(await readFile(file)).equals(before)) throw new Error("Personal settings changed while saving; retry");
		await rename(temp, file);
	} finally {
		await rm(temp, { force: true });
		await lock.close();
		await rm(lockPath);
	}
}
