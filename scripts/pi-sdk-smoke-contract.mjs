export const VERIFICATION_CONTRACT = "pi-sdk-behavior-v2";
export const SDK_NAMES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];
export const EXPECTED_SDK_VERSIONS = Object.fromEntries(SDK_NAMES.map((name) => [name, "1.2.0"]));
export const UNHANDLED_ERROR_PATTERN = /UnhandledPromiseRejection|uncaught exception|shutdown error/i;
export const EXTENSION_LOAD_ERROR_PATTERN = /Failed to load extension|Error loading extension/i;

export function parseJsonLines(output) {
	return output.split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}

function assertion(id, expected, observed, passed) {
	return { id, expected, observed, passed: passed === true };
}

function commandsResponse(responses) {
	return responses.find((row) => row?.type === "response" && row.command === "get_commands");
}

function commandRegistered(responses) {
	const response = commandsResponse(responses);
	return {
		response: response ?? null,
		command: response?.data?.commands?.find((command) => command.name === "auto-update-now") ?? null,
	};
}

function commandResponse(responses) {
	return responses.find((row) => row?.type === "response" && row.command === "prompt");
}

function notifications(responses) {
	return responses.filter((row) => row?.type === "extension_ui_request" && row.method === "notify");
}

export function behaviorAssertions(name, {
	responses,
	updaterInvocations,
	stdout,
	stderr,
	exit_code,
	processExited,
	timedOut,
	expectedVersion,
}) {
	const registration = commandRegistered(responses);
	const prompt = commandResponse(responses);
	const notifyRows = notifications(responses);
	const featureNotification = notifyRows.find((row) =>
		row.message === "Pi extensions and Pi update checks completed" && row.notifyType === "info",
	);

	if (name === "extension_load") {
		return [
			assertion(
				"extension_registered",
				"The actual Pi RPC command inventory contains the installed package command auto-update-now",
				registration,
				registration.response?.success === true && registration.command?.source === "extension",
			),
		];
	}
	if (name === "happy_path") {
		return [
			assertion(
				"feature_response",
				"The actual Pi host handles /auto-update-now, invokes both updater commands, and emits the successful update notification",
				{ registration, prompt: prompt ?? null, notifications: notifyRows, updaterInvocations },
				registration.command?.source === "extension" && prompt?.success === true &&
					prompt.data?.disposition === "handled" && !!featureNotification &&
					JSON.stringify(updaterInvocations) === JSON.stringify(["update --extensions", "update"]),
			),
		];
	}
	if (name === "error_path") {
		const handledFailure = notifyRows.find((row) =>
			row.notifyType === "warning" && typeof row.message === "string" &&
				row.message.startsWith("Pi auto-update failed\n") &&
				row.message.includes("extensions:") && row.message.includes("Pi:"),
		);
		return [
			assertion(
				"handled_error",
				"The real extension command handles unavailable updater executables, attempts both steps, and reports a warning",
				{ prompt: prompt ?? null, notification: handledFailure ?? null },
				prompt?.success === true && prompt.data?.disposition === "handled" && !!handledFailure,
			),
		];
	}
	if (name === "reload_cleanup") {
		return [
			assertion(
				"reloaded_extension_registered",
				"A second actual Pi process registers the installed package command",
				registration,
				registration.response?.success === true && registration.command?.source === "extension",
			),
			assertion(
				"reloaded_feature_response",
				"The second process handles /auto-update-now, invokes both updater commands, and emits the successful update notification",
				{ prompt: prompt ?? null, notifications: notifyRows, updaterInvocations },
				prompt?.success === true && prompt.data?.disposition === "handled" && !!featureNotification &&
					JSON.stringify(updaterInvocations) === JSON.stringify(["update --extensions", "update"]),
			),
			assertion(
				"clean_shutdown",
				"The second actual Pi process exits naturally with code zero",
				{ exit_code, processExited, timedOut, stdout_records: responses.length, stderr },
				exit_code === 0 && processExited === true && timedOut !== true,
			),
		];
	}
	if (name === "host_shell") {
		return [
			assertion(
				"native_shell_boundary",
				"The native host shell launches the local Pi shim and prints the pinned SDK version",
				{ exit_code, stdout: stdout.trim(), stderr: stderr.trim(), expectedVersion },
				exit_code === 0 && stdout.trim() === expectedVersion && stderr.trim() === "",
			),
		];
	}
	throw new Error(`Unknown smoke case: ${name}`);
}
