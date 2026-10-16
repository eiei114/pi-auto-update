import { spawn } from "node:child_process";
import path from "node:path";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], cwd: string, signal: AbortSignal) => Promise<CommandResult>;

/** No shell, bounded output, no interactive authentication, kill on cancellation. */
export const run: Runner = async (command, args, cwd, signal) => {
	signal.throwIfAborted();
	const env = { ...process.env };
	// Relative PATH entries would resolve inside the unreviewed staging directory.
	for (const key of Object.keys(env)) if (key.toLowerCase() === "path") {
		env[key] = env[key]?.split(path.delimiter).filter((dir) => path.isAbsolute(dir)).join(path.delimiter);
	}
	for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
	Object.assign(env, {
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: "4",
		GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
		GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
		GIT_CONFIG_KEY_2: "protocol.file.allow", GIT_CONFIG_VALUE_2: "never",
		GIT_CONFIG_KEY_3: "protocol.ext.allow", GIT_CONFIG_VALUE_3: "never",
		npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false",
		npm_config_git: "/usr/bin/false", npm_config_script_shell: "/usr/bin/false",
	});
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "", bytes = 0;
		let failure: Error | undefined;
		const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
		const abort = () => stop(new Error("Update cancelled"));
		const timer = setTimeout(() => stop(new Error("Command timed out")), 120_000);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		for (const [stream, output] of [[child.stdout, true], [child.stderr, false]] as const) {
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				bytes += Buffer.byteLength(chunk);
				if (bytes > 4 * 1024 * 1024) { stop(new Error("Command output exceeded limit")); return; }
				if (output) stdout += chunk; else stderr += chunk;
			});
		}
		child.on("error", (error) => { failure = error; });
		child.on("close", (code) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (failure) reject(failure);
			else resolve({ code: code ?? -1, stdout, stderr });
		});
	});
};

export async function checked(runner: Runner, command: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	const result = await runner(command, args, cwd, signal);
	if (result.code !== 0) throw new Error(`${command} failed (exit ${result.code})`);
	return result.stdout;
}

export function npmArgs(args: string[]): [string, string[]] {
	// npm's own JS entrypoint also works when tests are invoked through npm.
	const cli = process.env.npm_execpath;
	return cli && path.isAbsolute(cli) && /npm-cli\.js$/.test(cli) ? [process.execPath, [cli, ...args]] : ["npm", args];
}

export async function npm(runner: Runner, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	const [command, argv] = npmArgs(args);
	return checked(runner, command, argv, cwd, signal);
}
