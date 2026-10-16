import { assertReviewable, changes, hash, MAX_REVIEW_BYTES, reviewPayload, ReviewSizeError, type Change, type Snapshot } from "./tree.ts";
import { parseVerdict, type Reviewer, type Verdict } from "./review.ts";

export const MAX_REVIEW_BATCHES = 32;
const MIN_PACKET_BYTES = 8_192;
type Entry = NonNullable<Change["before"]>;
type Meta = Omit<Entry, "text"> & { length: number };
type File = { path: string; role: "change" | "manifest"; before: Meta | null; after: Meta | null;
	changeWindow: { before: [number, number]; after: [number, number] } | null };
type Slice = { start: number; end: number; total: number; text: string };
export type ReviewUnit = { file: number; part: number; parts: number; before: Slice | null; after: Slice | null; unchanged: boolean };
export type ReviewPlan = {
	label: string; baseline: string; candidateTree: string; digest: string; limit: number;
	files: File[]; batches: ReviewUnit[][];
};
export type ReviewEvidence = {
	mode: "single" | "batched"; planDigest?: string; files?: number; parts?: number;
	batches: number; completed: number; coverageVerified: boolean;
	packets: { kind: string; binding: string; bytes: number; verdict?: Verdict }[];
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const meta = (entry: Entry | null): Meta | null => entry && ({ kind: entry.kind, mode: entry.mode, hash: entry.hash, length: entry.text?.length ?? 0 });

function records(before: Snapshot, after: Snapshot) {
	const delta = changes(before, after);
	assertReviewable(delta);
	const result = delta.map((change) => ({ ...change, role: "change" as "change" | "manifest" }));
	const seen = new Set(delta.map((change) => change.path));
	for (const [path, entry] of after.files) {
		if (/(^|\/)package\.json$/.test(path) && !seen.has(path)) {
			if (entry.text === undefined) throw new Error("Non-text manifest requires manual review");
			// An unchanged manifest needs its full candidate content, not a duplicate baseline copy.
			result.push({ path, before: null, after: entry, role: "manifest" });
		}
	}
	return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function descriptor(record: ReturnType<typeof records>[number]): File {
	let changeWindow: File["changeWindow"] = null;
	if (record.role === "change" && record.before && record.after) {
		const a = record.before.text!, b = record.after.text!;
		let prefix = 0, suffix = 0;
		while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
		while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
		changeWindow = { before: [prefix, a.length - suffix], after: [prefix, b.length - suffix] };
	}
	return { path: record.path, role: record.role, before: meta(record.before), after: meta(record.after), changeWindow };
}

/** Split by serialized UTF-8 size, retaining every UTF-16 offset and never bisecting a surrogate pair. */
function slices(text: string, limit: number): Slice[] {
	if (!text.length) return [{ start: 0, end: 0, total: 0, text: "" }];
	const result: Slice[] = [];
	for (let start = 0; start < text.length;) {
		let lo = start + 1, hi = Math.min(text.length, start + limit), end = start;
		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (bytes(text.slice(start, mid)) <= limit) { end = mid; lo = mid + 1; } else hi = mid - 1;
		}
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		if (end <= start) throw new Error("Review packet budget cannot hold a text segment");
		result.push({ start, end, total: text.length, text: text.slice(start, end) });
		start = end;
	}
	return result;
}

function inventory(plan: ReviewPlan) {
	return plan.files.filter((file) => file.role === "change");
}
function batchBody(plan: ReviewPlan, units: ReviewUnit[], index: number, total: number) {
	return {
		protocol: "bounded-review-v1", kind: "batch", label: plan.label,
		baseline: plan.baseline, candidateTree: plan.candidateTree, planDigest: plan.digest,
		batch: index, batches: total, fileCount: plan.files.length,
		changeInventory: inventory(plan),
		// Include descriptors in each packet so a segment is never anonymous.
		files: [...new Set(units.map((unit) => unit.file))].map((index) => ({ index, ...plan.files[index] })),
		units, summaryLimit: 2_000,
	};
}
/** Verdict.candidate binds this exact review packet, including artifact/plan digests, not just the artifact. */
export function bindPacket(body: object, limit: number): { payload: string; binding: string } {
	const binding = hash(JSON.stringify(body));
	const payload = JSON.stringify({ ...body, candidate: binding });
	if (Buffer.byteLength(payload) > limit) throw new Error("Review packet exceeds bounded budget; manual review required");
	return { payload, binding };
}

export function buildReviewPlan(label: string, before: Snapshot, after: Snapshot, limit = MAX_REVIEW_BYTES): ReviewPlan {
	if (!Number.isSafeInteger(limit) || limit < MIN_PACKET_BYTES || limit > MAX_REVIEW_BYTES) throw new Error("Unsupported review packet budget");
	const source = records(before, after);
	const plan: ReviewPlan = {
		label, baseline: before.digest, candidateTree: after.digest, digest: "0".repeat(64), limit,
		files: source.map(descriptor),
		batches: [],
	};
	const overhead = bytes(batchBody(plan, [], MAX_REVIEW_BATCHES, MAX_REVIEW_BATCHES)) + 128;
	if (overhead > limit / 2) throw new Error("Change inventory exceeds bounded review budget; manual review required");
	const textLimit = Math.min(32_000, Math.floor((limit - overhead - 2_048) / 4));
	if (textLimit < 256) throw new Error("Insufficient review packet budget");
	const units: ReviewUnit[] = [];
	for (const [file, record] of source.entries()) {
		const beforeParts = record.before ? slices(record.before.text!, textLimit) : [];
		const afterParts = record.after ? slices(record.after.text!, textLimit) : [];
		const parts = Math.max(beforeParts.length, afterParts.length);
		for (let part = 0; part < parts; part++) units.push({ file, part, parts, before: beforeParts[part] ?? null, after: afterParts[part] ?? null,
			unchanged: beforeParts[part] !== undefined && afterParts[part] !== undefined && beforeParts[part].text === afterParts[part].text });
	}
	let current: ReviewUnit[] = [];
	for (const unit of units) {
		if (bytes({ ...batchBody(plan, [...current, unit], MAX_REVIEW_BATCHES, MAX_REVIEW_BATCHES), candidate: "0".repeat(64) }) > limit) {
			if (!current.length) throw new Error("Review segment exceeds packet budget");
			plan.batches.push(current); current = [];
		}
		current.push(unit);
	}
	if (current.length) plan.batches.push(current);
	if (!plan.batches.length || plan.batches.length > MAX_REVIEW_BATCHES) throw new Error("Review requires too many batches; manual review required");
	plan.digest = hash(JSON.stringify({ ...plan, digest: undefined }));
	verifyReviewPlan(plan, before, after);
	// Preflight every source packet before spending any model quota.
	plan.batches.forEach((units, i) => bindPacket(batchBody(plan, units, i + 1, plan.batches.length), limit));
	return plan;
}

/** Independent reconstruction check: no missing, duplicated, overlapping, reordered or altered content. */
export function verifyReviewPlan(plan: ReviewPlan, before: Snapshot, after: Snapshot): void {
	const source = records(before, after);
	const expected = source.map(descriptor);
	if (plan.baseline !== before.digest || plan.candidateTree !== after.digest ||
		JSON.stringify(plan.files) !== JSON.stringify(expected) ||
		plan.digest !== hash(JSON.stringify({ ...plan, digest: undefined }))) throw new Error("Review plan binding or file coverage mismatch");
	const all = plan.batches.flat();
	if (all.some((unit) => !Number.isInteger(unit.file) || unit.file < 0 || unit.file >= source.length)) throw new Error("Unknown review file");
	if (all.some((unit) => unit.unchanged !== (unit.before !== null && unit.after !== null && unit.before.text === unit.after.text))) throw new Error("Invalid unchanged-part assertion");
	for (const [index, record] of source.entries()) {
		const units = all.filter((unit) => unit.file === index);
		if (!units.length || units.some((unit, i) => unit.part !== i || unit.parts !== units.length)) throw new Error("Missing or duplicated review part");
		for (const side of ["before", "after"] as const) {
			const entry = record[side];
			const segments = units.map((unit) => unit[side]).filter((slice): slice is Slice => slice !== null);
			if (!entry) { if (segments.length) throw new Error("Unexpected review content"); continue; }
			let end = 0, text = "";
			for (const slice of segments) {
				if (slice.start !== end || slice.total !== entry.text!.length || slice.end !== slice.start + slice.text.length) throw new Error("Review coverage gap or overlap");
				end = slice.end; text += slice.text;
			}
			if (!segments.length || end !== entry.text!.length || text !== entry.text) throw new Error("Review content was omitted or altered");
		}
	}
}

/** Exact, explicitly bounded source context for integration; full streams were reviewed in source batches. */
function integrationContext(plan: ReviewPlan, before: Snapshot, after: Snapshot) {
	return inventory(plan).map((file) => ({ path: file.path, changeWindow: file.changeWindow,
		...Object.fromEntries((["before", "after"] as const).map((side) => {
			const entry = (side === "before" ? before : after).files.get(file.path);
			if (!entry) return [side, null];
			const text = entry.text!;
			const [start, end] = file.changeWindow?.[side] ?? [0, text.length];
			let ranges = [[Math.max(0, start - 256), Math.min(text.length, end + 256)]];
			if (ranges[0][1] - ranges[0][0] > 1_024) ranges = [
				[Math.max(0, start - 256), Math.min(text.length, start + 256)],
				[Math.max(0, end - 256), Math.min(text.length, end + 256)],
			];
			return [side, { fullChangeWindowIncluded: ranges.length === 1, excerpts: ranges.map(([a, b]) => {
				if (a > 0 && /[\\uDC00-\\uDFFF]/.test(text[a])) a--;
				if (b < text.length && /[\\uD800-\\uDBFF]/.test(text[b - 1])) b++;
				return { start: a, end: b, total: text.length, text: text.slice(a, b) };
			}) }];
		})),
	}));
}

async function checkedReview(reviewer: Reviewer, packet: { payload: string; binding: string }, signal: AbortSignal, model?: string): Promise<Verdict> {
	signal.throwIfAborted();
	let abort: (() => void) | undefined;
	try {
		const verdict = await Promise.race([
			reviewer(packet.payload, packet.binding, signal, model),
			new Promise<never>((_, reject) => {
				abort = () => reject(new Error("Security review cancelled or timed out"));
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
			}),
		]);
		signal.throwIfAborted();
		const validated = parseVerdict(JSON.stringify(verdict), packet.binding);
		return validated;
	} finally { if (abort) signal.removeEventListener("abort", abort); }
}

export async function reviewChangeSet(
	label: string, before: Snapshot, after: Snapshot, reviewer: Reviewer, signal: AbortSignal, model?: string,
	record: (evidence: ReviewEvidence) => void = () => {},
): Promise<Verdict> {
	const limit = Math.min(MAX_REVIEW_BYTES, reviewer.maxPayloadBytes?.(model) ?? MAX_REVIEW_BYTES);
	const combined = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
	let small: { payload: string; binding: string } | undefined;
	try {
		const { candidate: _tree, ...body } = JSON.parse(reviewPayload(label, before, after, limit - 256));
		small = bindPacket({ ...body, protocol: "bounded-review-v1", kind: "complete", candidateTree: after.digest }, limit);
	}
	catch (error) { if (!(error instanceof ReviewSizeError)) throw error; }
	const evidence: ReviewEvidence = { mode: small ? "single" : "batched", batches: 1, completed: 0, coverageVerified: false, packets: [] };
	record(evidence);
	async function ask(kind: string, packet: { payload: string; binding: string }) {
		const entry: ReviewEvidence["packets"][number] = { kind, binding: packet.binding, bytes: Buffer.byteLength(packet.payload) };
		evidence.packets.push(entry); record(evidence);
		const verdict = await checkedReview(reviewer, packet, combined, model);
		entry.verdict = verdict; evidence.completed++; record(evidence);
		if (verdict.decision !== "approve") throw new Error("Security reviewer blocked the update");
		return verdict;
	}
	if (small !== undefined) {
		evidence.coverageVerified = true;
		return ask("complete", small);
	}
	const plan = buildReviewPlan(label, before, after, limit);
	Object.assign(evidence, { planDigest: plan.digest, files: plan.files.length, parts: plan.batches.flat().length,
		batches: plan.batches.length + 1, coverageVerified: true });
	record(evidence);
	// Reserve space for every batch's evidence in the final cross-file review, without truncation.
	const contexts = integrationContext(plan, before, after);
	const summaryLimit = Math.min(2_000, Math.floor((limit - bytes(inventory(plan)) - bytes(contexts) - 8_192) / MAX_REVIEW_BATCHES) - 256);
	if (summaryLimit < 128) throw new Error("Cross-batch evidence cannot fit model context");
	const approvals: { batch: number; binding: string; reason: string }[] = [];
	for (const [i, units] of plan.batches.entries()) {
		const packet = bindPacket({ ...batchBody(plan, units, i + 1, plan.batches.length), summaryLimit }, limit);
		const verdict = await ask("batch", packet);
		if (Buffer.byteLength(verdict.reason) > summaryLimit) throw new Error("Batch evidence exceeds final review budget; manual review required");
		approvals.push({ batch: i + 1, binding: packet.binding, reason: verdict.reason });
	}
	verifyReviewPlan(plan, before, after);
	const final = bindPacket({
		protocol: "bounded-review-v1", kind: "integration", label, baseline: before.digest, candidateTree: after.digest,
		planDigest: plan.digest, coverageVerified: true, files: plan.files.length, parts: plan.batches.flat().length,
		batches: plan.batches.length, changeInventory: inventory(plan), sourceContext: contexts, approvals,
	}, limit);
	return ask("integration", final);
}
