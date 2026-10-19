/**
 * Two-line Pi 1.3.0 footer, independently implemented for pi-thagoras.
 * Layout inspiration: NihilDigit/pithagoras configs/pi/extensions/pi-footer.ts.
 * No upstream source is copied: no license was found in its public tree/package/README.
 * See docs/pi-footer.md for measurement semantics, attribution, activation and limits.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { ENTRY_TYPE, OutputMetrics, gitSummary, kvText, quotaText, resetText, restoreQuota, type QuotaState } from "./pi-footer/core.ts";
import { formatCapacity, renderFooter } from "./pi-footer/layout.ts";
import { loadProviderUsage, supportedProvider, UsagePoller } from "./pi-footer/usage.ts";

interface Runtime {
	ctx: ExtensionContext;
	sessionId: string;
	alive: boolean;
	model: Model<Api> | undefined;
	metrics: OutputMetrics;
	tps?: number;
	completedAt?: number;
	git: string;
	requestRender(): void;
	refreshGit(): void;
	poller: UsagePoller;
	dispose(): void;
}
export default function (pi: ExtensionAPI) {
	let current: Runtime | undefined;
	const active = (run: Runtime) => run.alive && current === run &&
		run.ctx.sessionManager.getSessionId() === run.sessionId;
	const forContext = (ctx: ExtensionContext) => current && active(current) &&
		ctx.sessionManager.getSessionId() === current.sessionId ? current : undefined;

	const makePoller = (run: Runtime, initial?: QuotaState) => {
		const provider = run.model?.provider;
		return new UsagePoller({
			sessionId: run.sessionId, provider: provider ?? "none", initial,
			load: signal => loadProviderUsage(provider, run.ctx.modelRegistry, signal),
			persist: state => { if (active(run)) pi.appendEntry(ENTRY_TYPE, state); },
			changed: () => run.requestRender(),
		});
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
			// Report only a closed set of labels/numbers. No auth lookup, HTTP, or arbitrary error text.
			ctx.ui.notify([
				`Usage provider: ${supportedProvider(run.model?.provider) ? run.model!.provider : "unsupported"}`,
				`Quota: ${diagnosis.code}${diagnosis.status === undefined ? "" : ` ${diagnosis.status}`}`,
				`Git: ${run.git || "pending/unavailable"} (+staged ~modified ?untracked-files !conflicts)`,
			].join("\n"), "info");
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
		let lastGit = 0;
		let gitAbort: AbortController | undefined;
		let unsubscribe: (() => void) | undefined;
		let requestRender = () => {};
		const run: Runtime = {
			ctx, sessionId, alive: true, model: ctx.model, metrics: new OutputMetrics(), git: "",
			requestRender: () => { if (active(run)) requestRender(); },
			poller: undefined!, // Assigned before publishing the runtime or starting any work.
			refreshGit() {
				if (!active(run) || gitTimer || gitPending) return;
				gitTimer = setTimeout(async () => {
					gitTimer = undefined;
					if (!active(run)) return;
					gitPending = true;
					gitAbort = new AbortController();
					try {
						const result = await pi.exec("git", ["status", "--porcelain=v1", "--branch", "--untracked-files=all", "-z"],
							{ cwd: ctx.cwd, timeout: 5_000, signal: gitAbort.signal });
						if (active(run)) run.git = result.code === 0 ? gitSummary(result.stdout) : "";
					} catch { if (active(run)) run.git = ""; }
					finally { gitPending = false; lastGit = Date.now(); run.requestRender(); }
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
				requestRender = () => {};
				if (current === run) current = undefined;
			},
		};
		run.poller = makePoller(run, restoreQuota(ctx.sessionManager.getEntries(), sessionId));
		current = run;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			unsubscribe = footerData.onBranchChange(() => { run.refreshGit(); run.requestRender(); });
			return {
				invalidate() {},
				dispose: () => run.dispose(),
				render(width: number): string[] {
					if (!active(run)) return ["", ""];
					const now = Date.now();
					const usage = ctx.getContextUsage();
					const capacity = usage?.contextWindow ?? run.model?.contextWindow;
					const percent = usage?.percent;
					return renderFooter({
						cwd: ctx.sessionManager.getCwd(), home: process.env.USERPROFILE ?? process.env.HOME,
						branch: footerData.getGitBranch(), git: run.git,
						context: `${percent == null ? "?" : percent.toFixed(1) + "%"}/${formatCapacity(capacity)}`,
						model: run.model?.id ?? "no-model", thinking: pi.getThinkingLevel() ?? "",
						dim: text => theme.fg("dim", text),
						quota: quotaText(run.poller.state, run.poller.failed, now),
						reset: resetText(run.poller.state, now), tps: run.tps,
						statuses: footerData.getExtensionStatuses(), kv: kvText(run.completedAt, now),
					}, width);
				},
			};
		});
		heartbeat = setInterval(() => {
			if (!active(run)) return;
			run.poller.tick();
			if (Date.now() - lastGit >= 15_000) run.refreshGit();
			run.requestRender();
		}, 1000);
		heartbeat.unref?.();
		run.refreshGit();
		void run.poller.request();
	});
	pi.on("session_shutdown", () => current?.dispose());
	pi.on("before_provider_request", (_event, ctx) => {
		const run = forContext(ctx);
		if (!run) return;
		run.metrics = new OutputMetrics();
		run.completedAt = undefined;
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
		run.completedAt = ["stop", "length", "toolUse"].includes(event.message.stopReason) ? Date.now() : undefined;
		run.requestRender();
		void run.poller.request();
	});
	pi.on("model_select", (event, ctx) => {
		const run = forContext(ctx);
		if (!run) return;
		const providerChanged = run.model?.provider !== event.model.provider;
		if (providerChanged || run.model?.id !== event.model.id) {
			run.tps = undefined;
			run.metrics = new OutputMetrics();
		}
		run.model = event.model;
		if (providerChanged) {
			const previous = run.poller.state ?? restoreQuota(ctx.sessionManager.getEntries(), run.sessionId);
			run.poller.dispose();
			run.poller = makePoller(run, previous);
			void run.poller.request();
		}
		run.requestRender();
	});
	pi.on("thinking_level_select", (_event, ctx) => forContext(ctx)?.requestRender());
	pi.on("tool_execution_end", (_event, ctx) => forContext(ctx)?.refreshGit());
	pi.on("user_bash", (_event, ctx) => forContext(ctx)?.refreshGit());
}
