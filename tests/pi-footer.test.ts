import { describe, expect, spyOn, test } from "bun:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import footer from "../extensions/pi-footer.ts";
import { acceptSample, CACHE_MS, ENTRY_TYPE, gitSummary, kvText, KV_IDLE_MS, KV_WARNING_MS,
	OutputMetrics, parseWeekUsage, quotaText, resetText, restoreQuota, type WeekSample } from "../extensions/pi-footer/core.ts";
import { formatCapacity, plain, renderFooter, row, statusText, type FooterView } from "../extensions/pi-footer/layout.ts";
import { loadUsage, UsagePoller, USAGE_URL } from "../extensions/pi-footer/usage.ts";

const START = 1_800_000_000_000;
const ACCOUNT = "a".repeat(64);
const sample = (used = 32, resetAt = START + 604800_000, fetchedAt = START): WeekSample => ({ used, resetAt, fetchedAt });
const body = (used = 32, seconds = 604800, reset = (START + 604800_000) / 1000) =>
	({ rate_limit: { secondary_window: { limit_window_seconds: seconds, used_percent: used, reset_at: reset } } });
const view: FooterView = {
	cwd: "C:/用户/项目/带中文的路径", branch: "功能/中文", git: "~2 ?1", context: "37.2%/272k",
	model: "gpt-5.4", thinking: "high", quota: "wk 32% (+3pp)", reset: "󰥔 2d 6h", tps: 48.6,
	statuses: new Map([["remote-pi:relay", "🟢 relay"], ["remote-pi:session", "📡 local (1)"]]), kv: "",
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("two-line layout", () => {
	test("fixed height and bounded visible columns over narrow, ANSI, CJK and resize widths", () => {
		for (const variant of [view, { ...view, cwd: "\x1b[31mC:/中文/é/项目\x1b[0m",
			model: "超长模型é".repeat(8), statuses: new Map([["other", "\x1b[32m中文 ANSI é 状态\x1b[0m"]]), kv: "KV expired" }]) {
			for (let width = 0; width <= 240; width++) {
				const lines = renderFooter(variant, width);
				expect(lines).toHaveLength(2);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line.includes("\n")).toBe(false);
				}
			}
		}
	});
	test("wide form includes all fields; narrow form prioritizes model/quota", () => {
		const lines = renderFooter({ ...view, kv: "KV 4m 32s" }, 180);
		expect(lines[0]).toContain("π C:/用户/项目/带中文的路径 (功能/中文) ~2 ?1 37.2%/272k");
		expect(lines[0].endsWith("gpt-5.4 high")).toBe(true);
		expect(lines[1]).toContain("wk 32% (+3pp) 󰥔 2d 6h 48.6 tok/s");
		expect(lines[1].endsWith(" relay   local (1)  KV 4m 32s")).toBe(true);
		expect(renderFooter(view, 20)[0]).toContain("gpt-5.4 high");
		expect(renderFooter(view, 20)[1]).toContain("wk 32% (+3pp)");
		expect(stripTerminalSequences(renderFooter(view, 5)[1])).toBe("wk 32");
		expect(renderFooter({ ...view, quota: "wk 32% (+3pp) stale" }, 10)[1]).toContain("wk stale");
		expect(renderFooter({ ...view, quota: "wk 32% (+3pp) stale" }, 14)[1]).toContain("wk 32% stale");
	});
	test("ANSI row preserves bounds even at width one", () => {
		for (let width = 0; width < 50; width++) {
			const line = row("\x1b[31m左侧中文\x1b[0m", "\x1b[32m右侧é\x1b[0m", width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(renderFooter(view, NaN)).toEqual(["", ""]);
		expect(formatCapacity(undefined)).toBe("?");
		expect(formatCapacity(272000)).toBe("272k");
	});
	test("statuses preserve other extension text and remote semantics, never invent connectivity", () => {
		expect(statusText(new Map())).toBe("");
		expect(statusText(new Map([["remote-pi:relay", "🟡 relay waiting for pairing"],
			["remote-pi:session", "📡 local (0)"], ["remote-pi:peer-active", "📱 手机"],
			["custom", "\x1b[31m上下文 · 警告\x1b[0m"]])))
			.toBe(" relay waiting for pairing   local (0)   手机  上下文 警告");
		expect(plain("\x1b]0;bad title\x07🟢 x · y\n● z")).toBe("x y z");
		const kvLine = renderFooter({ ...view, kv: "KV expired" }, 180)[1];
		expect(stripTerminalSequences(kvLine)).toBe(kvLine);
	});
});

describe("weekly quota and session baseline", () => {
	test("select weekly by duration in either position, not 5h position", () => {
		expect(parseWeekUsage(body(), START)).toEqual(sample());
		const primary = body().rate_limit.secondary_window;
		expect(parseWeekUsage({ rate_limit: { primary_window: primary,
			secondary_window: { ...primary, limit_window_seconds: 18000, used_percent: 90 } } }, START)).toEqual(sample());
	});
	test("missing/invalid windows never become zero", () => {
		for (const value of [null, {}, body(0, 18000), body(NaN), body(-1), body(101),
			{ rate_limit: { primary_window: { limit_window_seconds: 604800, reset_at: 1 } } }]) {
			expect(parseWeekUsage(value, START)).toBeUndefined();
		}
		expect(parseWeekUsage(body(0), START)?.used).toBe(0);
		expect(quotaText(undefined, false, START)).toBe("wk …");
		expect(quotaText(undefined, true, START)).toBe("wk unavailable");
	});
	test("baseline persists and restores session-wide, rejects fork and malformed data", () => {
		const initial = acceptSample(undefined, sample(29), "s", ACCOUNT);
		const updated = acceptSample(initial, sample(32), "s", ACCOUNT);
		const entries = [{ type: "custom", customType: ENTRY_TYPE, data: initial },
			{ type: "custom", customType: ENTRY_TYPE, data: updated }];
		const restored = restoreQuota(JSON.parse(JSON.stringify(entries)), "s")!;
		expect(restored.baseline.used).toBe(29);
		expect(restored.delta).toBe(3);
		expect(quotaText(restored, false, START)).toBe("wk 32% (+3pp)");
		expect(restoreQuota(entries, "fork")).toBeUndefined();
		expect(restoreQuota([{ ...entries[0], data: { ...initial, delta: NaN } }], "s")).toBeUndefined();
		expect(acceptSample(updated, sample(9), "s", "b".repeat(64)).delta).toBe(0);
	});
	test("reset keeps known observations, explicitly marks unobserved tail and missed windows", () => {
		let state = acceptSample(undefined, sample(29, START + 1000), "s", ACCOUNT);
		state = acceptSample(state, sample(32, START + 1000), "s", ACCOUNT);
		expect(quotaText(state, false, START + 1000)).toContain("32%");
		expect(quotaText(state, false, START + 1000)).toContain("stale");
		expect(resetText(state, START + 1000)).toBe("󰥔 reset due");
		state = acceptSample(state, sample(2, START + 604800_000, START + 2000), "s", ACCOUNT);
		expect(state.delta).toBe(5);
		expect(state.unobserved).toBe(true);
		expect(quotaText(state, false, START + 2000)).toBe("wk 2% (~+5pp unobserved)");
		expect(quotaText(state, true, START + 2000)).toEndWith(" stale");
		state = acceptSample(state, sample(1, state.latest.resetAt, START + 3000), "s", ACCOUNT);
		expect(state.delta).toBe(5);
		expect(resetText(undefined, START)).toBe("");
	});
});

describe("usage HTTP and cache/backoff", () => {
	test("uses existing OAuth resolution, fixed HTTPS endpoint, required headers, persists only hash/sample", async () => {
		const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.x`;
		let resolutions = 0;
		const result = await loadUsage(async () => { resolutions++; return { source: "OAuth", auth: { apiKey: token } }; },
			new AbortController().signal, (async (url, init) => {
				expect(url).toBe(USAGE_URL);
				expect(init?.method).toBe("GET");
				expect(init?.redirect).toBe("error");
				expect(init?.headers).toEqual({ Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "fake-account", Accept: "application/json" });
				return Response.json(body());
			}) as typeof fetch, () => START);
		expect(resolutions).toBe(1);
		expect(result.sample).toEqual(sample());
		expect(result.account).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result)).not.toContain(token);
		expect(JSON.stringify(result)).not.toContain("fake-account");
	});
	test("missing OAuth, malformed JWT, HTTP failure and missing weekly window are failures", async () => {
		let fetches = 0;
		const mock = (async () => { fetches++; return Response.json({}); }) as typeof fetch;
		await expect(loadUsage(async () => undefined, new AbortController().signal, mock)).rejects.toThrow();
		await expect(loadUsage(async () => ({ source: "API key", auth: { apiKey: "not-oauth" } }), new AbortController().signal, mock)).rejects.toThrow();
		await expect(loadUsage(async () => ({ source: "OAuth", auth: { apiKey: "bad" } }), new AbortController().signal, mock)).rejects.toThrow();
		expect(fetches).toBe(0);
		const auth = async () => ({ source: "OAuth", auth: { apiKey: "fake", headers: { "ChatGPT-Account-Id": "fake-account" } } });
		await expect(loadUsage(auth, new AbortController().signal, mock)).rejects.toThrow("payload-missing-weekly");
		await expect(loadUsage(auth, new AbortController().signal,
			(async () => new Response("sensitive error body", { status: 401 })) as typeof fetch)).rejects.toThrow("http 401");
	});
	test("60s cache, coalescing, failure retains stale data, exponential retry and recovery", async () => {
		let now = START, calls = 0, fail = false;
		const saved: unknown[] = [];
		const poller = new UsagePoller({ sessionId: "s", now: () => now, changed() {}, persist: v => saved.push(v),
			load: async () => { calls++; if (fail) throw Error("fake"); return { account: ACCOUNT, sample: sample(32, START + 604800_000, now) }; } });
		try {
			await Promise.all([poller.request(), poller.request()]);
			expect(calls).toBe(1);
			await poller.request(); expect(calls).toBe(1);
			now += CACHE_MS; fail = true;
			await poller.request(); expect(calls).toBe(2);
			expect(quotaText(poller.state, poller.failed, now)).toContain("32% (+0pp) stale");
			now += CACHE_MS - 1; await poller.request(); expect(calls).toBe(2);
			now++; await poller.request(); expect(calls).toBe(3);
			now += CACHE_MS; await poller.request(); expect(calls).toBe(3);
			now += CACHE_MS; fail = false; await poller.request(); expect(calls).toBe(4);
			expect(poller.failed).toBe(false); expect(saved).toHaveLength(2);
		} finally { poller.dispose(); }
	});
	test("reset invalidates fresh cache, never locally sets percent to zero", async () => {
		let now = START, calls = 0;
		const poller = new UsagePoller({ sessionId: "s", now: () => now, changed() {}, persist() {},
			load: async () => { calls++; return { account: ACCOUNT, sample: sample(32, START + 1000, now) }; } });
		try {
			await poller.request();
			now += 1000; poller.tick(); await flush();
			expect(calls).toBe(2); expect(poller.state?.latest.used).toBe(32);
			poller.tick(); await flush(); expect(calls).toBe(2);
		} finally { poller.dispose(); }
	});
	test("resume honors fresh cache; timeout aborts; disposal rejects late session data", async () => {
		const initial = acceptSample(undefined, sample(), "s", ACCOUNT);
		let resolve!: (v: { account: string; sample: WeekSample }) => void;
		let signal: AbortSignal | undefined, persisted = 0, changed = 0;
		const p = new UsagePoller({ sessionId: "s", changed: () => changed++, persist: () => persisted++,
			load: s => { signal = s; return new Promise(r => { resolve = r; }); }, timeoutMs: 10 });
		await p.request(); expect(signal?.aborted).toBe(true); expect(p.failed).toBe(true);
		expect(p.diagnostic).toEqual({ code: "timeout" }); p.dispose();
		const stale = new UsagePoller({ sessionId: "old", changed: () => changed++, persist: () => persisted++,
			load: s => { signal = s; return new Promise(r => { resolve = r; }); } });
		const request = stale.request(); stale.dispose();
		resolve({ account: ACCOUNT, sample: sample() }); await request;
		expect(signal?.aborted).toBe(true); expect(stale.state).toBeUndefined(); expect(persisted).toBe(0);
		let calls = 0;
		const resumed = new UsagePoller({ sessionId: "s", initial, now: () => START + 1000,
			changed() {}, persist() {}, load: async () => { calls++; throw Error(); } });
		await resumed.request(); expect(calls).toBe(0); resumed.dispose();
	});
});

describe("output metrics and KV", () => {
	test("TPS excludes TTFT, usage tail, tools; reasoning is subset of output, not added twice", () => {
		const metrics = new OutputMetrics();
		metrics.raw({ type: "response.created" }, 0);
		metrics.raw({ type: "response.output_item.added", item: { type: "reasoning" } }, 5000);
		metrics.normalized({ type: "thinking_delta", delta: "summary" }, 6000);
		metrics.normalized({ type: "toolcall_delta", delta: "{}" }, 7000);
		metrics.raw({ type: "response.completed" }, 12000);
		expect(metrics.finish({ usage: { output: 100, reasoning: 50 }, stopReason: "toolUse" })).toBe(50);
		expect(metrics.finish({ usage: { output: 100 }, stopReason: "aborted" })).toBeUndefined();
		expect(metrics.finish({ usage: { output: 100 }, stopReason: "error" })).toBeUndefined();
	});
	test("text/function args work, but no real usage or unobservable reasoning yields no fabricated rate", () => {
		const metrics = new OutputMetrics();
		metrics.normalized({ type: "text_start" }, 0);
		metrics.normalized({ type: "text_delta", delta: "" }, 1);
		metrics.normalized({ type: "text_delta", delta: "a" }, 500);
		expect(metrics.finish({ usage: { output: 5 }, stopReason: "stop" })).toBeUndefined();
		metrics.raw({ type: "response.function_call_arguments.delta", delta: "a" }, 1500);
		expect(metrics.finish({ usage: { output: 5 }, stopReason: "stop" })).toBe(5);
		expect(metrics.finish({ usage: { output: 5, reasoning: 2 }, stopReason: "stop" })).toBeUndefined();
		for (const usage of [undefined, {}, { output: 0 }, { output: NaN }]) {
			expect(metrics.finish({ usage, stopReason: "stop" })).toBeUndefined();
		}
	});
	test("KV only last five minutes, exact expiry, new request hidden", () => {
		expect(kvText(undefined, START)).toBe("");
		expect(kvText(START, START + KV_IDLE_MS - KV_WARNING_MS - 1)).toBe("");
		expect(kvText(START, START + KV_IDLE_MS - KV_WARNING_MS)).toBe("KV 5m 0s");
		expect(kvText(START, START + KV_IDLE_MS - 272000)).toBe("KV 4m 32s");
		expect(kvText(START, START + KV_IDLE_MS - 1)).toBe("KV 0m 1s");
		expect(kvText(START, START + KV_IDLE_MS)).toBe("KV expired");
		expect(kvText(START, START + KV_IDLE_MS + 1)).toBe("KV expired");
	});
});

test("Git counts conflicts/renames/newline filenames without exposing filenames", () => {
	expect(gitSummary("## main...origin/main [ahead 2, behind 1]\0R  new\0old\0 M file\nname\0?? untracked\0UU conflict\0"))
		.toBe("ahead:2 behind:1 !1 +1 ~1 ?1");
	expect(gitSummary("## main\0")).toBe("clean");
});

test("TPS lifecycle retains last valid rate across requests/unmeasured responses and resets only on model identity changes", () => {
	const handlers = new Map<string, Function>();
	let factory: Function | undefined;
	let clock = 0;
	const now = spyOn(performance, "now").mockImplementation(() => clock);
	footer({
		on: (name: string, fn: Function) => { handlers.set(name, fn); return () => {}; },
		registerCommand() {},
		appendEntry() {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		getThinkingLevel: () => "high",
	} as never);
	const model = { provider: "provider-a", id: "model-a", contextWindow: 272000 };
	const ctx = {
		mode: "tui", cwd: "C:/Codes/example", model,
		sessionManager: { getSessionId: () => "tps", getEntries: () => [], getCwd: () => "C:/Codes/example" },
		getContextUsage: () => undefined,
		modelRegistry: { getProviderAuth: async () => undefined },
		ui: { setFooter: (value: Function) => { factory = value; } },
	};
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
	const delta = (time: number) => {
		clock = time;
		emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "output" } });
	};
	const end = (usage: unknown, stopReason = "stop") => emit("message_end", { message: { role: "assistant", usage, stopReason } });
	try {
		emit("session_start");
		const component = factory!({ requestRender() {} }, { fg: (_token: string, text: string) => text }, {
			onBranchChange: () => () => {}, getGitBranch: () => null, getExtensionStatuses: () => new Map(),
		});
		const line = () => component.render(180)[1] as string;
		end(undefined); expect(line()).not.toContain("tok/s");
		emit("before_provider_request"); delta(1000);
		emit("model_select", { model: { ...model } }); // Same identity must preserve in-progress observations.
		delta(3000); end({ output: 100 });
		expect(line()).toContain("50.0 tok/s");
		for (const [usage, reason] of [[undefined, "stop"], [{ output: 0 }, "stop"],
			[{ output: 100 }, "aborted"], [{ output: 100 }, "error"], [{ output: 100 }, "toolUse"]] as const) {
			emit("before_provider_request");
			expect(line()).toContain("50.0 tok/s"); // Keep the completed response during the next request.
			end(usage, reason);
			expect(line()).toContain("50.0 tok/s"); // No measurable interval or valid usage must not erase it.
		}
		emit("before_provider_request"); delta(5000);
		expect(line()).toContain("50.0 tok/s");
		delta(7000); end({ output: 120 }, "toolUse");
		expect(line()).toContain("60.0 tok/s");
		emit("model_select", { model: { ...model, provider: "provider-b" } });
		expect(line()).not.toContain("tok/s");
		end({ output: 120 }); expect(line()).not.toContain("tok/s"); // Old observations were reset too.
		emit("before_provider_request"); delta(9000); delta(11000); end({ output: 80 });
		expect(line()).toContain("40.0 tok/s");
		emit("model_select", { model: { ...model, provider: "provider-b", id: "model-b" } });
		expect(line()).not.toContain("tok/s");
		end({ output: 80 }); expect(line()).not.toContain("tok/s");
	} finally { emit("session_shutdown"); now.mockRestore(); }
});

test("extension lifecycle: no resources in factory/non-TUI; render no network; disposal unsubscribes and cancels old auth", async () => {
	const handlers = new Map<string, Function>();
	let authCalls = 0, branchSubscriptions = 0, branchUnsubs = 0, footerFactory: Function | undefined;
	let pendingAuth: ((value: undefined) => void) | undefined;
	const pi = {
		on: (name: string, fn: Function) => { handlers.set(name, fn); return () => handlers.delete(name); },
		registerCommand() {},
		appendEntry() { throw Error("no late persistence expected"); },
		exec: async () => { throw Error("git must not run before disposal"); }, getThinkingLevel: () => "high",
	};
	footer(pi as never); expect(authCalls).toBe(0);
	let id = "old", now = START;
	const realNow = Date.now;
	Date.now = () => now;
	const ctx = {
		mode: "rpc", cwd: "C:/Codes/example", model: { provider: "openai", id: "test-model", contextWindow: 272000 },
		sessionManager: { getSessionId: () => id, getEntries: () => [], getCwd: () => "C:/Codes/example" },
		getContextUsage: () => ({ percent: 12.5, contextWindow: 272000 }),
		modelRegistry: { getProviderAuth: async () => { authCalls++; return new Promise<undefined>(r => { pendingAuth = r; }); } },
		ui: { setFooter: (factory: Function) => { footerFactory = factory; } },
	};
	try {
		handlers.get("session_start")!({}, ctx); expect(authCalls).toBe(0);
		ctx.mode = "tui"; handlers.get("session_start")!({}, ctx); expect(authCalls).toBe(1);
		const component = footerFactory!({ requestRender() {} }, { fg: (_token: string, text: string) => text }, {
			onBranchChange: () => { branchSubscriptions++; return () => branchUnsubs++; },
			getGitBranch: () => "main", getExtensionStatuses: () => new Map([["other", "kept"]]),
		});
		for (let w = 0; w < 100; w++) expect(component.render(w)).toHaveLength(2);
		expect(authCalls).toBe(1);
		handlers.get("before_provider_request")!({}, ctx);
		handlers.get("message_update")!({ assistantMessageEvent: { type: "text_delta", delta: "a" } }, ctx);
		handlers.get("message_end")!({ message: { role: "assistant", stopReason: "stop", usage: { output: 1 } } }, ctx);
		now += KV_IDLE_MS - KV_WARNING_MS;
		expect(component.render(180)[1]).toContain("KV 5m 0s");
		handlers.get("before_provider_request")!({}, ctx);
		expect(component.render(180)[1]).not.toContain("KV");
		id = "new"; component.dispose(); component.dispose(); pendingAuth?.(undefined); await flush();
		expect(branchSubscriptions).toBe(1); expect(branchUnsubs).toBe(1);
		expect(component.render(100)).toEqual(["", ""]);
	} finally { Date.now = realNow; handlers.get("session_shutdown")!({}, ctx); pendingAuth?.(undefined); }
});
