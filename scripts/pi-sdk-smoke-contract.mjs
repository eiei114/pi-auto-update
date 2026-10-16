export const VERIFICATION_CONTRACT = "pi-sdk-security-gate-v3";
export const SDK_NAMES = [
	"@earendil-works/pi-agent-core", "@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
];
export const EXPECTED_SDK_VERSIONS = Object.fromEntries(SDK_NAMES.map((name) => [name, "1.2.0"]));
export const UNHANDLED_ERROR_PATTERN = /UnhandledPromiseRejection|uncaught exception|shutdown error/i;
export const EXTENSION_LOAD_ERROR_PATTERN = /Failed to load extension|Error loading extension/i;
export function parseJsonLines(output) {
	return output.split(/\r?\n/).flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}
const assertion = (id, expected, observed, passed) => ({ id, expected, observed, passed: passed === true });

export function behaviorAssertions(name, {
	responses, updaterInvocations = [], stdout, stderr, exit_code, processExited, timedOut, expectedVersion,
}) {
	const inventory = responses.find((row) => row.type === "response" && row.command === "get_commands");
	const command = inventory?.data?.commands?.find((row) => row.name === "auto-update-now");
	const prompt = responses.find((row) => row.type === "response" && row.command === "prompt");
	const notifications = responses.filter((row) => row.type === "extension_ui_request" && row.method === "notify");
	const registered = inventory?.success === true && command?.source === "extension";
	const handled = prompt?.success === true && prompt.data?.disposition === "handled";
	const completed = notifications.some((row) => row.message.startsWith("Pi security update completed: 0 updated, 0 blocked") && row.notifyType === "info");
	const blocked = notifications.some((row) => row.message === "Pi security update blocked: offline mode" && row.notifyType === "warning");
	const observed = { command, prompt, notifications, updaterInvocations };
	if (name === "extension_load") return [assertion("extension_registered", "Actual Pi registers the installed extension command", observed, registered)];
	if (name === "happy_path" || name === "reload_cleanup") {
		const checks = [assertion(name === "happy_path" ? "feature_response" : "reloaded_feature_response",
			"Pi handles a no-target security check without invoking an unconditional updater", observed,
			registered && handled && completed && updaterInvocations.length === 0)];
		if (name === "reload_cleanup") checks.push(assertion("clean_shutdown", "Second Pi process exits naturally with code zero",
			{ exit_code, processExited, timedOut }, exit_code === 0 && processExited === true && !timedOut));
		return checks;
	}
	if (name === "error_path") return [assertion("handled_error",
		"Manual checks cannot bypass offline mode", observed, handled && blocked && updaterInvocations.length === 0)];
	if (name === "host_shell") return [assertion("native_shell_boundary", "Native shell prints the pinned Pi version",
		{ exit_code, stdout, stderr, expectedVersion }, exit_code === 0 && stdout.trim() === expectedVersion && stderr.trim() === "")];
	throw new Error("Unknown smoke case: " + name);
}
