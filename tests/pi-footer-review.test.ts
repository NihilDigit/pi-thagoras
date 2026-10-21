import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import footer from "../extensions/pi-footer.ts";
import { acceptSample, gitSummary } from "../extensions/pi-footer/core.ts";
import { renderFooter, type FooterView } from "../extensions/pi-footer/layout.ts";
import { loadProviderUsage, loadUsage, safeDiagnostic, UsageFailure, UsagePoller } from "../extensions/pi-footer/usage.ts";

const NOW = 1_800_000_000_000;
const sample = { used: 32, resetAt: NOW + 604800_000, fetchedAt: NOW };
const body = { rate_limit: { primary_window: { limit_window_seconds: 604800, used_percent: 32, reset_at: sample.resetAt / 1000 } } };
const account = "a".repeat(64);
const fakeToken = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.token`;
const auth = async () => ({ source: "OAuth", auth: { apiKey: fakeToken } });
const response = (async () => Response.json(body)) as typeof fetch;
const flush = () => new Promise(r => setTimeout(r, 0));

test("real installed Pi 1.3.0 ModelRegistry/resolver/openai OAuth toAuth contract with memory-only credentials", async () => {
	const root = process.env.PI_FOOTER_PI_ROOT!;
	const installed = (relative: string) => import(pathToFileURL(resolve(root, relative)).href);
	const [{ ModelRegistry }, { resolveProviderAuth }, { openaiProvider }] = await Promise.all([
		installed("dist/core/model-registry.js"), installed("../pi-ai/dist/auth/resolve.js"), installed("../pi-ai/dist/providers/openai.js"),
	]);
	const provider = openaiProvider();
	let credential: any = { type: "oauth", access: fakeToken, refresh: "synthetic-refresh", expires: Date.now() + 3600_000 };
	let refreshes = 0, modifications = 0;
	// Keep official resolver/locking/toAuth; substitute only the token exchange (no real network).
	const memoryProvider = { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth,
		refresh: async () => { refreshes++; return { ...credential, expires: Date.now() + 3600_000 }; },
	} } };
	const store = {
		read: async () => credential,
		modify: async (_id: string, fn: Function) => { modifications++; credential = await fn(credential) ?? credential; return credential; },
	};
	const calls: string[] = [];
	const registry = new ModelRegistry({ getAuth: (id: string) => {
		calls.push(id); expect(id).toBe("openai");
		return resolveProviderAuth(memoryProvider, store, { env: async () => undefined, fileExists: async () => false });
	} });
	const resolved = await registry.getProviderAuth("openai");
	expect(resolved.source).toBe("OAuth"); expect(resolved.auth.apiKey).toBe(fakeToken);
	expect(resolved.auth.headers).toBeUndefined(); // Real openai OAuth has no account header.
	const usage = await loadProviderUsage("openai", registry, new AbortController().signal, response, () => NOW);
	expect(usage.sample).toEqual(sample); expect(modifications).toBe(0);
	credential.expires = 0;
	await loadProviderUsage("openai", registry, new AbortController().signal, response, () => NOW);
	expect(refreshes).toBe(1); expect(modifications).toBe(1);
	credential = { type: "api_key", key: "synthetic-api-key" };
	await expect(loadProviderUsage("openai", registry, new AbortController().signal, response)).rejects.toThrow("auth-non-oauth");
	expect(calls.every(id => id === "openai")).toBe(true);
});

test("provider binding never falls back to codex or sends a regular API key as a subscription token", async () => {
	const calls: string[] = [];
	let fetches = 0;
	const registry = { getProviderAuth: async (id: string) => { calls.push(id); return undefined; } };
	const fetcher = (async () => { fetches++; return Response.json(body); }) as typeof fetch;
	await expect(loadProviderUsage("openai", registry, new AbortController().signal, fetcher)).rejects.toThrow("auth-missing");
	await expect(loadProviderUsage("unrelated", registry, new AbortController().signal, fetcher)).rejects.toThrow("auth-missing");
	expect(calls).toEqual(["openai"]); expect(fetches).toBe(0);
});

test("safe diagnostics classify failures without arbitrary errors, account, token, or HTTP body", async () => {
	const signal = () => new AbortController().signal;
	const check = async (operation: Promise<unknown>, expected: unknown) => {
		try { await operation; throw Error("expected failure"); }
		catch (e) {
			const diagnostic = safeDiagnostic(e);
			expect(diagnostic).toEqual(expected);
			const text = JSON.stringify(diagnostic);
			for (const secret of [fakeToken, "synthetic-account", "sensitive-body"]) expect(text).not.toContain(secret);
		}
	};
	await check(loadUsage(async () => undefined, signal(), response), { code: "auth-missing" });
	await check(loadUsage(async () => ({ source: fakeToken, auth: { apiKey: fakeToken } }), signal(), response), { code: "auth-non-oauth" });
	await check(loadUsage(async () => { throw Error(fakeToken); }, signal(), response), { code: "auth-error" });
	await check(loadUsage(async () => ({ source: "OAuth", auth: { apiKey: "opaque-synthetic-token" } }), signal(), response), { code: "account-missing" });
	let bodyReads = 0;
	await check(loadUsage(auth, signal(), (async () => ({ ok: false, status: 403,
		text: async () => { bodyReads++; return "sensitive-body"; } })) as typeof fetch), { code: "http", status: 403 });
	expect(bodyReads).toBe(0);
	await check(loadUsage(auth, signal(), (async () => { throw Error(fakeToken); }) as typeof fetch), { code: "network" });
	await check(loadUsage(auth, signal(), (async () => Response.json({ detail: "sensitive-body" })) as typeof fetch), { code: "payload-missing-weekly" });
	await check(loadUsage(auth, signal(), (async () => new Response("sensitive-body")) as typeof fetch), { code: "payload-missing-weekly" });
	const cancelled = new AbortController(); cancelled.abort();
	await check(loadUsage(auth, cancelled.signal, response), { code: "timeout" });
	expect(safeDiagnostic(new Error(fakeToken))).toEqual({ code: "internal" });
	expect(safeDiagnostic(new UsageFailure(fakeToken as never))).toEqual({ code: "internal" });
});

test("provider switch hides old account data until revalidated; same account preserves baseline, different account resets", async () => {
	const initial = { ...acceptSample(undefined, { ...sample, used: 29 }, "s", account), authProvider: "openai-codex" };
	const next = new UsagePoller({ sessionId: "s", provider: "openai", initial, now: () => NOW,
		load: async () => ({ account, sample }), persist() {}, changed() {} });
	try {
		expect(next.state).toBeUndefined(); await next.request();
		expect(next.state?.delta).toBe(3); expect(next.state?.authProvider).toBe("openai");
	} finally { next.dispose(); }
	const other = new UsagePoller({ sessionId: "s", provider: "openai", initial, now: () => NOW,
		load: async () => ({ account: "b".repeat(64), sample }), persist() {}, changed() {} });
	try { await other.request(); expect(other.state?.delta).toBe(0); } finally { other.dispose(); }
});

test("single-line footer remains bounded under dim ANSI", () => {
	const view: FooterView = { cwd: "C:/中文/项目", branch: "main", git: "~6 ?30", bar: "", context: "37%/272k",
		model: "GPT-5.4", thinking: "high", quota: " 32% (+3%)", reset: "󰥔 54h", secondaryQuota: " 11%", tps: 48.6,
		statuses: new Map([["compact", "compact ready"], ["worktree", "main"]]),
		dim: text => `\x1b[2m${text}\x1b[22m` };
	for (const model of ["gpt-5.4", "GPT-5.4", "claude-opus"]) {
		for (let width = 0; width <= 240; width++) {
			const lines = renderFooter({ ...view, model }, width);
			expect(lines).toHaveLength(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
	const wide = renderFooter(view, 180);
	expect(stripTerminalSequences(wide[0])).toContain(" 32% (+3%) 󰥔 54h │  11% │ 48.6 tok/s │ compact ready  main │ Context  37%/272k");
});

test("real repository porcelain -z untracked-file count agrees with independent git ls-files", () => {
	const options = { encoding: "utf8" as const, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
	const raw = execFileSync("git", ["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"], options);
	const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], options).split("\0").filter(Boolean).length;
	const summary = gitSummary(raw);
	expect(Number(summary.match(/\?(\d+)/)?.[1] ?? 0)).toBe(untracked);
	expect(summary).toMatch(/^[\x20-\x7e]+$/);
	expect(summary).not.toContain("/");
});

test("read-only /pi-footer status is safe and does not trigger auth, HTTP, models, or Git", async () => {
	const handlers = new Map<string, Function>(), commands = new Map<string, any>();
	const notifications: string[] = [], providers: string[] = [];
	let factory: Function | undefined, gitCalls = 0;
	footer({
		on: (name: string, fn: Function) => { handlers.set(name, fn); return () => {}; },
		registerCommand: (name: string, cmd: unknown) => commands.set(name, cmd),
		appendEntry() {}, exec: async () => { gitCalls++; return { code: 0, stdout: "" }; }, getThinkingLevel: () => "high",
	} as never);
	const ctx = { mode: "tui", cwd: "C:/Codes/example", model: { provider: "openai", id: "gpt-5.4" },
		sessionManager: { getSessionId: () => "s", getEntries: () => [], getCwd: () => "C:/Codes/example" },
		getContextUsage: () => undefined,
		modelRegistry: { getProviderAuth: async (provider: string) => { providers.push(provider); throw Error(fakeToken); } },
		ui: { setFooter: (f: Function) => { factory = f; }, notify: (text: string) => notifications.push(text) },
	};
	try {
		handlers.get("session_start")!({}, ctx); await flush();
		const component = factory!({ requestRender() {} }, { fg: (_: string, text: string) => text }, {
			onBranchChange: () => () => {}, getGitBranch: () => null, getExtensionStatuses: () => new Map(),
		});
		expect(providers).toEqual(["openai"]);
		const beforeGit = gitCalls;
		await commands.get("pi-footer").handler("status", ctx);
		expect(notifications.at(-1)).toContain("Usage provider: openai\nQuota: auth-error");
		expect(notifications.join(" ")).not.toContain(fakeToken);
		expect(providers).toHaveLength(1); expect(gitCalls).toBe(beforeGit);
		expect(notifications.at(-1)).not.toContain("Model icon");
		const first = component.render(180)[0];
		expect(first).toContain("C:/Codes/example");
		await commands.get("pi-footer").handler("icon chip", ctx);
		expect(notifications.at(-1)).toBe("Usage: /pi-footer status");
		expect(component.render(180)[0]).toBe(first);
		expect(providers).toHaveLength(1);
		handlers.get("model_select")!({ model: { ...ctx.model, provider: "openai-codex" } }, ctx);
		await flush();
		expect(providers).toEqual(["openai", "openai-codex"]); // Only an explicit provider switch permits this lookup.
		await commands.get("pi-footer").handler("status", ctx);
		expect(notifications.at(-1)).toContain("Usage provider: openai-codex\nQuota: auth-error");
	} finally { handlers.get("session_shutdown")!({}, ctx); }
});
