import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { contextBar, ENTRY_TYPE, gitBranchFromPorcelain, gitSummary, ICON_CLAUDE, ICON_GOOGLE, ICON_OPENAI, OutputMetrics, quotaText, resetText, restoreQuota, secondaryQuotaText, type QuotaState } from "./pi-footer/core.ts";
import { formatCapacity, renderFooter } from "./pi-footer/layout.ts";
import { isAgyProvider, loadAgyCliUsage, loadCodexCliUsage, loadProviderUsage, quotaPoolKey, supportedProvider, UsagePoller } from "./pi-footer/usage.ts";

function quotaLabel(provider: string | undefined, modelId: string | undefined, dual: boolean): string {
	if (!dual) return "wk";
	if (/^claude/i.test((modelId ?? "").trim())) return ICON_CLAUDE;
	return isAgyProvider(provider) ? ICON_GOOGLE : ICON_OPENAI;
}

interface Runtime {
	ctx: ExtensionContext;
	sessionId: string;
	alive: boolean;
	dual: boolean;
	model: Model<Api> | undefined;
	metrics: OutputMetrics;
	tps?: number;
	git: string;
	gitBranch?: string;
	pools: Map<string, QuotaState>;
	requestRender(): void;
	refreshGit(): void;
	poller: UsagePoller;
	companion?: UsagePoller;
	dispose(): void;
}

export default function (pi: ExtensionAPI) {
	let current: Runtime | undefined;
	const active = (run: Runtime) => run.alive && current === run &&
		run.ctx.sessionManager.getSessionId() === run.sessionId;
	const forContext = (ctx: ExtensionContext) => current && active(current) &&
		ctx.sessionManager.getSessionId() === current.sessionId ? current : undefined;

	const makePollerFor = (run: Runtime, provider: string | undefined, modelId: string | undefined, initial?: QuotaState) => {
		const pool = quotaPoolKey(provider, modelId);
		return new UsagePoller({
			sessionId: run.sessionId, provider: pool, initial: run.pools.get(pool) ?? initial,
			load: signal => loadProviderUsage(provider, run.ctx.modelRegistry, signal, undefined, Date.now, modelId),
			persist: state => {
				if (active(run)) {
					run.pools.set(pool, state);
					pi.appendEntry(ENTRY_TYPE, state);
				}
			},
			changed: () => run.requestRender(),
		});
	};
	const makePoller = (run: Runtime, initial?: QuotaState) =>
		makePollerFor(run, run.model?.provider, run.model?.id, initial);
	const makeCompanion = (run: Runtime): UsagePoller | undefined => {
		if (!run.dual || !supportedProvider(run.model?.provider)) return undefined;
		const compProvider = isAgyProvider(run.model?.provider) ? "openai" : "cliproxyapi";
		const compModel = compProvider === "cliproxyapi" ? "gemini-4-argon-high" : "gpt-6-astra";
		const pool = quotaPoolKey(compProvider, compModel);
		const initial = run.pools.get(pool) ?? restoreQuota(run.ctx.sessionManager.getEntries(), run.sessionId, pool);
		return makePollerFor(run, compProvider, compModel, initial);
	};

	pi.registerCommand("pi-footer", {
		description: "Read safe footer status",
		handler: async (args, ctx) => {
			const request = args.trim();
			const run = forContext(ctx);
			if (request && request !== "status") {
				ctx.ui.notify("Usage: /pi-footer status", "info");
				return;
			}
			if (!run) { ctx.ui.notify("Footer inactive (TUI session required)", "info"); return; }
			const diagnosis = run.poller.diagnostic;
			const lines = [
				`Usage provider: ${supportedProvider(run.model?.provider) ? run.model!.provider : "unsupported"}`,
				`Quota: ${diagnosis.code}${diagnosis.status === undefined ? "" : ` ${diagnosis.status}`}`,
			];
			if (run.companion) {
				const comp = run.companion.diagnostic;
				lines.push(`Companion quota: ${comp.code}${comp.status === undefined ? "" : ` ${comp.status}`}`);
			}
			lines.push(`Git: ${run.git || "pending/unavailable"} (+staged ~modified ?untracked-files !conflicts)`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		current?.dispose();
		current = undefined;
		if (ctx.mode !== "tui") return;
		const sessionId = ctx.sessionManager.getSessionId();
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let gitTimer: ReturnType<typeof setTimeout> | undefined;
		let gitPending = false;
		let gitQueued = false;
		let lastGit = 0;
		let gitAbort: AbortController | undefined;
		let unsubscribe: (() => void) | undefined;
		let requestRender = () => {};
		const dual = typeof (ctx.modelRegistry as unknown as Record<string, unknown>)?.getAll === "function";
		const run: Runtime = {
			ctx, sessionId, alive: true, dual, model: ctx.model, metrics: new OutputMetrics(), git: "", pools: new Map(),
			requestRender: () => { if (active(run)) requestRender(); },
			poller: undefined!,
			refreshGit() {
				if (!active(run)) return;
				if (gitTimer || gitPending) {
					gitQueued = true;
					return;
				}
				gitTimer = setTimeout(async () => {
					gitTimer = undefined;
					if (!active(run)) return;
					gitPending = true;
					gitQueued = false;
					gitAbort = new AbortController();
					try {
						const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
						const result = await pi.exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"],
							{ cwd, timeout: 5_000, signal: gitAbort.signal });
						if (active(run)) {
							run.git = result.code === 0 ? gitSummary(result.stdout) : "";
							run.gitBranch = result.code === 0 ? gitBranchFromPorcelain(result.stdout) : undefined;
						}
					} catch {
						if (active(run)) {
							run.git = "";
							run.gitBranch = undefined;
						}
					} finally {
						gitPending = false;
						lastGit = Date.now();
						run.requestRender();
						if (gitQueued && active(run)) {
							gitQueued = false;
							run.refreshGit();
						}
					}
				}, 150);
				gitTimer.unref?.();
			},
			dispose() {
				if (!run.alive) return;
				run.alive = false;
				if (heartbeat) clearInterval(heartbeat);
				if (gitTimer) clearTimeout(gitTimer);
				gitAbort?.abort();
				unsubscribe?.();
				unsubscribe = undefined;
				run.poller.dispose();
				run.companion?.dispose();
				requestRender = () => {};
				if (current === run) current = undefined;
			},
		};
		const entries = ctx.sessionManager.getEntries();
		const primaryPool = quotaPoolKey(run.model?.provider, run.model?.id);
		run.poller = makePoller(run, restoreQuota(entries, sessionId, dual ? primaryPool : undefined) ?? restoreQuota(entries, sessionId));
		run.companion = makeCompanion(run);
		current = run;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			unsubscribe = footerData.onBranchChange(() => { run.refreshGit(); run.requestRender(); });
			return {
				invalidate() {},
				dispose: () => run.dispose(),
				render(width: number): string[] {
					if (!active(run)) return [""];
					const now = Date.now();
					const usage = ctx.getContextUsage();
					const capacity = usage?.contextWindow ?? run.model?.contextWindow;
					const percent = usage?.percent;
					const tokens = usage?.tokens;
					const pLabel = quotaLabel(run.model?.provider, run.model?.id, run.dual);
					const sLabel = isAgyProvider(run.model?.provider) ? ICON_OPENAI : ICON_GOOGLE;
					const rawBar = contextBar(percent);
					const barRole = percent != null && percent >= 80
						? "error"
						: percent != null && percent >= 50
							? "warning"
							: "accent";
					const styledBar = theme.fg(barRole, rawBar);
					const baseLines = renderFooter({
						cwd: ctx.sessionManager.getCwd(), home: process.env.USERPROFILE ?? process.env.HOME,
						branch: footerData.getGitBranch() ?? run.gitBranch, git: run.git,
						bar: styledBar,
						context: `${percent == null ? "?" : percent.toFixed(1) + "%"}/${formatCapacity(capacity)}`,
						model: run.model?.id ?? "no-model", thinking: pi.getThinkingLevel() ?? "",
						dim: text => theme.fg("dim", text),
						color: (role, text) => theme.fg(role, text),
						quota: quotaText(run.poller.state, run.poller.failed, now, pLabel),
						reset: resetText(run.poller.state, now),
						secondaryQuota: run.companion ? secondaryQuotaText(run.companion.state, run.companion.failed, sLabel) : undefined,
						tps: run.tps,
						statuses: footerData.getExtensionStatuses(),
					}, width);
					const drawerRender = (globalThis as any).__piSubagentDrawerLines as ((w: number, t: any) => string[]) | undefined;
					const drawerLines = typeof drawerRender === "function" ? drawerRender(width, theme) : [];
					return drawerLines.length > 0 ? [...baseLines, ...drawerLines] : baseLines;
				},
			};
		});
		heartbeat = setInterval(() => {
			if (!active(run)) return;
			run.poller.tick();
			run.companion?.tick();
			if (Date.now() - lastGit >= 15_000) run.refreshGit();
			run.requestRender();
		}, 1000);
		heartbeat.unref?.();
		run.refreshGit();
		void run.poller.request();
		void run.companion?.request();
	});
	pi.on("session_shutdown", () => current?.dispose());
	pi.on("before_provider_request", (_event, ctx) => {
		const run = forContext(ctx);
		if (!run) return;
		run.metrics = new OutputMetrics(performance.now());
		run.requestRender();
	});
	pi.on("message_update", (event, ctx) => {
		forContext(ctx)?.metrics.normalized(event.assistantMessageEvent, performance.now());
	});
	pi.on("provider_stream_event", (event, ctx) => {
		forContext(ctx)?.metrics.raw(event.data, performance.now());
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const run = forContext(ctx);
		if (!run) return;
		const measured = run.metrics.finish(event.message);
		if (measured !== undefined && Number.isFinite(measured)) run.tps = measured;
		run.requestRender();
		void run.poller.request();
		void run.companion?.request();
	});
	pi.on("model_select", (event, ctx) => {
		const run = forContext(ctx);
		if (!run) return;
		const oldPool = quotaPoolKey(run.model?.provider, run.model?.id);
		const newPool = quotaPoolKey(event.model.provider, event.model.id);
		if (run.model?.provider !== event.model.provider || run.model?.id !== event.model.id) {
			run.tps = undefined;
			run.metrics = new OutputMetrics();
		}
		run.model = event.model;
		if (oldPool !== newPool) {
			if (run.poller.state) run.pools.set(oldPool, run.poller.state);
			const entries = ctx.sessionManager.getEntries();
			const previous = run.pools.get(newPool) ?? restoreQuota(entries, run.sessionId, run.dual ? newPool : undefined) ?? run.poller.state ?? restoreQuota(entries, run.sessionId);
			run.poller.dispose();
			run.companion?.dispose();
			run.poller = makePoller(run, previous);
			run.companion = makeCompanion(run);
			void run.poller.request();
			void run.companion?.request();
		}
		run.requestRender();
	});
	pi.on("thinking_level_select", (_event, ctx) => forContext(ctx)?.requestRender());
	pi.on("tool_execution_end", (_event, ctx) => forContext(ctx)?.refreshGit());
	pi.on("user_bash", (_event, ctx) => forContext(ctx)?.refreshGit());
}
