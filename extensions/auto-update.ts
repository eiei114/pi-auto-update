import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-auto-update";
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;

type UpdateStep = {
	label: string;
	args: string[];
};

const UPDATE_STEPS: UpdateStep[] = [
	{ label: "extensions", args: ["update", "--extensions"] },
	{ label: "Pi", args: ["update"] },
];

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

			try {
				for (const step of UPDATE_STEPS) {
					ctx.ui.setStatus(STATUS_KEY, `Updating ${step.label}...`);

					try {
						const result = await pi.exec("pi", step.args, {
							cwd: ctx.cwd,
							timeout: UPDATE_TIMEOUT_MS,
						});

						if (result.code !== 0) {
							const detail = lastOutputLine(result.stdout, result.stderr);
							failures.push(`${step.label}: exit ${result.code}${detail ? ` — ${detail}` : ""}`);
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						failures.push(`${step.label}: ${message.slice(0, 300)}`);
					}
				}
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}

			if (!ctx.hasUI) return;

			if (failures.length > 0) {
				ctx.ui.notify(`Pi auto-update failed\n${failures.join("\n")}`, "warning");
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
