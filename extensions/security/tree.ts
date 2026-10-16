import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

type Entry = { kind: "file" | "link"; mode: number; hash: string; text?: string };
export type Snapshot = { digest: string; files: Map<string, Entry> };
export type Change = { path: string; before: Entry | null; after: Entry | null };
export const MAX_REVIEW_BYTES = 180_000;
export class ReviewSizeError extends Error {}
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_MEMORY_BYTES = 128 * 1024 * 1024;

async function hashOpaqueFile(file: string): Promise<{ digest: string; bytes: number }> {
	const digest = createHash("sha256");
	let bytes = 0;
	for await (const chunk of createReadStream(file)) {
		bytes += chunk.length;
		if (bytes > MAX_FILE_BYTES) throw new Error("Package file exceeds streaming byte limit");
		digest.update(chunk);
	}
	return { digest: digest.digest("hex"), bytes };
}
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Hash every installed byte, including dependencies. Never follow links while walking. */
export async function snapshot(root: string, includeGit = false): Promise<Snapshot> {
	if (!(await lstat(root)).isDirectory()) throw new Error("Package root must be a real directory");
	const canonical = await realpath(root);
	const files = new Map<string, Entry>();
	let bytes = 0, textBytes = 0;
	async function walk(dir: string, prefix: string) {
		for (const name of (await readdir(dir)).sort()) {
			if (!includeGit && prefix === "" && name === ".git") continue;
			const relative = prefix + name;
			const absolute = path.join(dir, name);
			const stat = await lstat(absolute);
			if (stat.isDirectory()) {
				if (relative.split("/").length > 100) throw new Error("Package tree exceeds depth limit");
				await walk(absolute, relative + "/"); continue;
			}
			if (files.size >= 100_000) throw new Error("Package tree exceeds file limit");
			if (stat.isSymbolicLink()) {
				const target = await readlink(absolute);
				const resolved = await realpath(absolute);
				if (path.isAbsolute(target) || !resolved.startsWith(canonical + path.sep)) {
					throw new Error("Package contains an escaping symlink");
				}
				files.set(relative, { kind: "link", mode: 0, hash: hash(target), text: target });
			} else if (stat.isFile()) {
				bytes += stat.size;
				if (stat.size > MAX_FILE_BYTES || bytes > MAX_TREE_BYTES) throw new Error("Package tree exceeds streaming byte limit");
				if (stat.size > MAX_TEXT_FILE_BYTES || textBytes + stat.size > MAX_TEXT_MEMORY_BYTES) {
					const opaque = await hashOpaqueFile(absolute);
					bytes += opaque.bytes - stat.size;
					if (bytes > MAX_TREE_BYTES) throw new Error("Package tree exceeds streaming byte limit");
					files.set(relative, { kind: "file", mode: stat.mode & 0o777, hash: opaque.digest });
					continue;
				}
				textBytes += stat.size;
				const data = await readFile(absolute);
				let text: string | undefined;
				try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { /* opaque binary */ }
				if (text?.includes("\0")) text = undefined;
				files.set(relative, { kind: "file", mode: stat.mode & 0o777, hash: hash(data), text });
			} else throw new Error("Package contains a special file");
		}
	}
	await walk(root, "");
	const identity = [...files].map(([name, entry]) => [name, entry.kind, entry.mode, entry.hash]);
	return { digest: hash(JSON.stringify(identity)), files };
}

export function changes(before: Snapshot, after: Snapshot): Change[] {
	const result: Change[] = [];
	for (const name of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
		const a = before.files.get(name) ?? null, b = after.files.get(name) ?? null;
		if (a?.kind === b?.kind && a?.hash === b?.hash && a?.mode === b?.mode) continue;
		if ((a && a.text === undefined) || (b && b.text === undefined)) {
			throw new Error("Changed binary, oversized or non-UTF-8 file requires manual review");
		}
		result.push({ path: name, before: a, after: b });
	}
	return result;
}

export function assertReviewable(delta: Change[]): void {
	if (delta.some((change) => /(^|\/)(\.env(?:\.[^/]*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|auth\.json)$/.test(change.path))) {
		throw new Error("Potential credential/configuration file changed; manual review required");
	}
}

/** Complete old/new contents rather than lossy/truncated diff hunks. */
export function reviewPayload(label: string, before: Snapshot, after: Snapshot, limit = MAX_REVIEW_BYTES): string {
	const delta = changes(before, after);
	assertReviewable(delta);
	const payload = JSON.stringify({
		label, baseline: before.digest, candidate: after.digest,
		manifests: [...after.files].filter(([name]) => /(^|\/)package\.json$/.test(name)).map(([name, entry]) => ({
			path: name, content: entry.text,
		})),
		changes: delta,
	});
	if (Buffer.byteLength(payload) > limit) throw new ReviewSizeError("Complete review exceeds size limit; manual review required");
	return payload;
}
