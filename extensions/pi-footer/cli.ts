import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { agyQuotaBucketId, parseAgyUsage, parseCodexRateLimits } from "./core.ts";
import { abortable, UsageFailure, type AccountSample } from "./usage.ts";

export type SupportedProvider = "openai" | "openai-codex" | "cliproxyapi" | "antigravity";
export function isAgyProvider(provider: string | undefined): provider is "cliproxyapi" | "antigravity" {
	return provider === "cliproxyapi" || provider === "antigravity";
}
export function quotaPoolKey(provider: string | undefined, modelId?: string): string {
	if (provider !== "openai" && provider !== "openai-codex" && !isAgyProvider(provider)) return "none";
	return isAgyProvider(provider) ? `${provider}:${agyQuotaBucketId(modelId)}` : provider;
}

function findInPath(names: readonly string[], extraDirs: readonly string[] = []): string | undefined {
	const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs].filter(Boolean);
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

function resolveCodexCommand(): { command: string; args: string[] } | undefined {
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const extra = home ? [join(home, "scoop", "apps", "nodejs-lts", "current", "bin")] : [];
	if (process.platform === "win32") {
		const exe = findInPath(["codex.exe"], extra);
		if (exe) return { command: exe, args: ["app-server"] };
		const shim = findInPath(["codex.cmd", "codex"], extra);
		if (shim) {
			const script = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
			if (existsSync(script)) return { command: process.execPath, args: [script, "app-server"] };
		}
		return undefined;
	}
	const bin = findInPath(["codex"], extra);
	return bin ? { command: bin, args: ["app-server"] } : undefined;
}

function resolveAgyBinary(): string | undefined {
	const local = process.env.LOCALAPPDATA ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local") : "");
	const extra = local ? [join(local, "agy", "bin")] : [];
	return findInPath(process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"], extra);
}

export function runCodexAppServerRateLimits(signal: AbortSignal): Promise<unknown> {
	if (signal.aborted) return Promise.reject(new UsageFailure("timeout"));
	const resolved = resolveCodexCommand();
	if (!resolved) return Promise.reject(new UsageFailure("cli-missing"));
	return new Promise((resolve, reject) => {
		let settled = false, requested = false, buffer = "";
		const child = spawn(resolved.command, resolved.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			try { child.kill(); } catch {}
			fn();
		};
		const onAbort = () => finish(() => reject(new UsageFailure("timeout")));
		signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", () => finish(() => reject(new UsageFailure("cli-error"))));
		child.stdin.on("error", () => finish(() => reject(new UsageFailure("cli-error"))));
		child.once("exit", () => finish(() => reject(new UsageFailure(signal.aborted ? "timeout" : "cli-error"))));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				let msg: Record<string, unknown>;
				try { msg = JSON.parse(line); } catch { continue; }
				if (msg.id === 1 && !requested) {
					requested = true;
					child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":null}\n');
				} else if (msg.id === 2) {
					finish(() => msg.error ? reject(new UsageFailure("cli-error")) : resolve(msg));
					return;
				}
			}
		});
		child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"pi-footer","version":"1.0.0"}}}\n');
	});
}

export function runAgyUsageJson(signal: AbortSignal): Promise<unknown> {
	if (signal.aborted) return Promise.reject(new UsageFailure("timeout"));
	const binary = resolveAgyBinary();
	if (!binary) return Promise.reject(new UsageFailure("cli-missing"));
	return new Promise((resolve, reject) => {
		let settled = false, stdout = "";
		const child = spawn(binary, ["-p", "/usage", "--output-format", "json"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			try { child.kill(); } catch {}
			fn();
		};
		const onAbort = () => finish(() => reject(new UsageFailure("timeout")));
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { if (stdout.length < 512_000) stdout += chunk; });
		child.once("error", () => finish(() => reject(new UsageFailure("cli-error"))));
		child.once("close", (code) => {
			if (signal.aborted) { finish(() => reject(new UsageFailure("timeout"))); return; }
			if (code !== 0) { finish(() => reject(new UsageFailure("cli-error"))); return; }
			try { const parsed = JSON.parse(stdout.trim()); finish(() => resolve(parsed)); }
			catch { finish(() => reject(new UsageFailure("payload-missing-weekly"))); }
		});
	});
}

export async function loadCodexCliUsage(signal: AbortSignal, now: () => number = Date.now,
	runner: (signal: AbortSignal) => Promise<unknown> = runCodexAppServerRateLimits): Promise<AccountSample> {
	const parsed = parseCodexRateLimits(await abortable(runner(signal), signal), now());
	if (!parsed) throw new UsageFailure("payload-missing-weekly");
	return { account: createHash("sha256").update(`codex:${parsed.accountId ?? "default"}`).digest("hex"), sample: parsed.sample };
}

export async function loadAgyCliUsage(modelId: string | undefined, signal: AbortSignal, now: () => number = Date.now,
	runner: (signal: AbortSignal) => Promise<unknown> = runAgyUsageJson): Promise<AccountSample> {
	const parsed = parseAgyUsage(await abortable(runner(signal), signal), modelId, now());
	if (!parsed) throw new UsageFailure("payload-missing-weekly");
	return { account: createHash("sha256").update(`agy:${parsed.bucketId}`).digest("hex"), sample: parsed.sample };
}
