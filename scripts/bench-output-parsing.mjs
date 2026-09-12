/**
 * Micro-benchmark for failure-path output parsing in auto-update.
 * Run: node scripts/bench-output-parsing.mjs
 */

const ITERATIONS = 500;
const LINE = "npm http fetch GET 200 https://registry.npmjs.org/example 45ms\n";

function makeVerboseOutput(lines) {
	const stdout = LINE.repeat(lines);
	const stderr = `${LINE.repeat(Math.floor(lines / 10))}npm ERR! code EBUSY\nnpm ERR! exit code 4294963214\n`;
	return { stdout, stderr };
}

function lastOutputLineBaseline(stdout, stderr) {
	const lines = `${stdout}\n${stderr}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1)?.slice(0, 300);
}

function lastOutputLineOptimized(stdout, stderr) {
	const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout;
	let end = combined.length;
	while (end > 0) {
		let start = end;
		while (start > 0 && combined[start - 1] !== "\n") start -= 1;
		const line = combined.slice(start, end).replace(/\r$/, "").trim();
		if (line) return line.slice(0, 300);
		end = start;
		while (end > 0 && combined[end - 1] === "\n") end -= 1;
	}
	return undefined;
}

const WINDOWS_PACKAGE_LOCK_PATTERNS = [
	/\bEBUSY\b/i,
	/\b4294963214\b/,
	/-4082\b/,
];

function isWindowsPackageLockFailureBaseline(output) {
	return WINDOWS_PACKAGE_LOCK_PATTERNS.some((pattern) => pattern.test(output));
}

function isWindowsPackageLockFailureOptimized(stdout, stderr) {
	const sources = stderr ? [stderr, stdout] : [stdout];
	for (const text of sources) {
		if (WINDOWS_PACKAGE_LOCK_PATTERNS.some((pattern) => pattern.test(text))) return true;
	}
	return false;
}

function bench(name, fn) {
	const start = performance.now();
	for (let i = 0; i < ITERATIONS; i += 1) fn();
	const elapsedMs = performance.now() - start;
	return { name, elapsedMs, perCallUs: (elapsedMs * 1000) / ITERATIONS };
}

function runCase(label, lines) {
	const { stdout, stderr } = makeVerboseOutput(lines);
	const combined = `${stdout}\n${stderr}`;

	const baselineLast = bench(`lastOutputLine baseline (${label})`, () => {
		lastOutputLineBaseline(stdout, stderr);
	});
	const optimizedLast = bench(`lastOutputLine optimized (${label})`, () => {
		lastOutputLineOptimized(stdout, stderr);
	});

	const baselineLock = bench(`packageLock baseline (${label})`, () => {
		isWindowsPackageLockFailureBaseline(combined);
	});
	const optimizedLock = bench(`packageLock optimized (${label})`, () => {
		isWindowsPackageLockFailureOptimized(stdout, stderr);
	});

	const lastSpeedup = baselineLast.elapsedMs / optimizedLast.elapsedMs;
	const lockSpeedup = baselineLock.elapsedMs / optimizedLock.elapsedMs;

	console.log(`\n=== ${label} (~${lines} stdout lines) ===`);
	for (const row of [baselineLast, optimizedLast, baselineLock, optimizedLock]) {
		console.log(
			`${row.name}: ${row.elapsedMs.toFixed(2)} ms total, ${row.perCallUs.toFixed(1)} µs/call`,
		);
	}
	console.log(`lastOutputLine speedup: ${lastSpeedup.toFixed(2)}x`);
	console.log(`packageLock speedup: ${lockSpeedup.toFixed(2)}x`);

	const baselineResult = lastOutputLineBaseline(stdout, stderr);
	const optimizedResult = lastOutputLineOptimized(stdout, stderr);
	if (baselineResult !== optimizedResult) {
		throw new Error(`lastOutputLine mismatch for ${label}: ${baselineResult} vs ${optimizedResult}`);
	}
}

console.log(`Iterations per case: ${ITERATIONS}`);
runCase("small", 50);
runCase("medium", 500);
runCase("large", 5000);
