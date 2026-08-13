import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-auto-update";
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";

type UpdateStep = {
	label: string;
	args: string[];
};

type CommandInvocation = {
	command: string;
	args: string[];
};

const UPDATE_STEPS: UpdateStep[] = [
	{ label: "extensions", args: ["update", "--extensions"] },
	{ label: "Pi", args: ["update"] },
];

const WINDOWS_PACKAGE_LOCK_PATTERNS = [
	/\bEBUSY\b/i,
	/\b4294963214\b/,
	/\b-4082\b/,
];
const WINDOWS_PACKAGE_LOCK_NOTICE =
	"extensions: deferred — Windows package files are in use; close all Pi runtimes and run pi update --extensions from a shell";

/**
 * npm and pnpm install Windows CLI entrypoints as .cmd shims. Pi's exec API
 * deliberately uses shell:false, so resolve those shims through cmd.exe.
 */
export function getPiCommandInvocation(
	args: string[],
	platform: NodeJS.Platform = process.platform,
	comSpec: string | undefined = process.env.ComSpec ?? process.env.COMSPEC,
): CommandInvocation {
	if (platform !== "win32") return { command: "pi", args };

	return {
		command: comSpec || "cmd.exe",
		args: ["/d", "/s", "/c", ["pi", ...args].join(" ")],
	};
}

function isTruthy(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value ?? "");
}

function isFalsey(value: string | undefined): boolean {
	return /^(0|false|no)$/i.test(value ?? "");
}

function shouldSkipAutoUpdate(): string | undefined {
	if (isTruthy(process.env.PI_OFFLINE)) return "offline mode";
	if (isFalsey(process.env.PI_AUTO_UPDATE)) return "PI_AUTO_UPDATE is disabled";
	return undefined;
}

export function getExtensionUpdateSkipReason(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (platform !== "win32") return undefined;
	if (env[INTERCOM_SESSION_ID_ENV]?.trim()) {
		return "an active pi-intercom runtime may keep extension package files locked";
	}
	return undefined;
}

export function isWindowsPackageLockFailure(
	output: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return false;
	return WINDOWS_PACKAGE_LOCK_PATTERNS.some((pattern) => pattern.test(output));
}

function lastOutputLine(stdout: string, stderr: string): string | undefined {
	const lines = `${stdout}\n${stderr}`
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.at(-1)?.slice(0, 300);
}

export default function (pi: ExtensionAPI) {
	let inFlight: Promise<void> | undefined;

	async function runUpdates(ctx: ExtensionContext): Promise<void> {
		if (inFlight) return inFlight;

	inFlight = (async () => {
			const failures: string[] = [];
			const notices: string[] = [];
			const extensionSkipReason = getExtensionUpdateSkipReason();
			const steps = extensionSkipReason
				? UPDATE_STEPS.filter((step) => step.label !== "extensions")
				: UPDATE_STEPS;

			if (extensionSkipReason) {
				notices.push(
					`extensions: skipped — ${extensionSkipReason}; close all Pi runtimes and run pi update --extensions from a shell`,
				);
			}

			try {
				for (const step of steps) {
					ctx.ui.setStatus(STATUS_KEY, `Updating ${step.label}...`);

					try {
						const invocation = getPiCommandInvocation(step.args);
						const result = await pi.exec(invocation.command, invocation.args, {
							cwd: ctx.cwd,
							timeout: UPDATE_TIMEOUT_MS,
						});

						if (result.code !== 0) {
							const detail = lastOutputLine(result.stdout, result.stderr);
							const output = `${result.stdout}\n${result.stderr}`;
							if (step.label === "extensions" && isWindowsPackageLockFailure(output)) {
								notices.push(WINDOWS_PACKAGE_LOCK_NOTICE);
							} else {
								failures.push(`${step.label}: exit ${result.code}${detail ? ` — ${detail}` : ""}`);
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (step.label === "extensions" && isWindowsPackageLockFailure(message)) {
							notices.push(WINDOWS_PACKAGE_LOCK_NOTICE);
						} else {
							failures.push(`${step.label}: ${message.slice(0, 300)}`);
						}
					}
				}
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}

			if (!ctx.hasUI) return;

			if (failures.length > 0) {
				ctx.ui.notify(`Pi auto-update failed\n${failures.join("\n")}`, "warning");
			} else if (notices.length > 0) {
				ctx.ui.notify(`Pi auto-update completed\n${notices.join("\n")}`, "info");
			} else {
				ctx.ui.notify("Pi extensions and Pi update checks completed", "info");
			}
		})().finally(() => {
			inFlight = undefined;
		});

		return inFlight;
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;

		const skipReason = shouldSkipAutoUpdate();
		if (skipReason) {
			if (ctx.hasUI) ctx.ui.notify(`Pi auto-update skipped: ${skipReason}`, "info");
			return;
		}

		await runUpdates(ctx);
	});

	pi.registerCommand("auto-update-now", {
		description: "Run pi update --extensions, then pi update",
		handler: async (_args, ctx) => {
			await runUpdates(ctx);
		},
	});
}
