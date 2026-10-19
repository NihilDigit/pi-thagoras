/** Footer-only state. Independently implemented; no upstream footer code is copied. */
export const WEEK_SECONDS = 604800;
export const CACHE_MS = 60_000;
export const KV_IDLE_MS = 30 * 60_000;
export const KV_WARNING_MS = 5 * 60_000;
export const ENTRY_TYPE = "pi-footer:quota-v1";

export function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export interface WeekSample { used: number; resetAt: number; fetchedAt: number }

/** Window position is not stable: identify duration, never assume secondary is weekly. */
export function parseWeekUsage(body: unknown, now: number): WeekSample | undefined {
	const limit = object(object(body)?.rate_limit);
	for (const name of ["primary_window", "secondary_window"]) {
		const window = object(limit?.[name]);
		if (window?.limit_window_seconds !== WEEK_SECONDS) continue;
		if (!finite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100 ||
			!finite(window.reset_at) || window.reset_at <= 0) continue;
		return { used: window.used_percent, resetAt: window.reset_at * 1000, fetchedAt: now };
	}
	return undefined;
}

export interface QuotaState {
	version: 1;
	sessionId: string;
	account: string; // SHA-256 account fingerprint, never the account ID or token.
	authProvider?: string; // Optional for pre-provider-binding entries; revalidated before reuse.
	baseline: WeekSample;
	latest: WeekSample;
	delta: number;
	unobserved: boolean;
}
function validSample(v: unknown): v is WeekSample {
	const s = object(v);
	return !!s && finite(s.used) && s.used >= 0 && s.used <= 100 &&
		finite(s.resetAt) && s.resetAt > 0 && finite(s.fetchedAt) && s.fetchedAt > 0;
}
export function restoreQuota(entries: readonly unknown[], sessionId: string): QuotaState | undefined {
	let restored: QuotaState | undefined;
	// Account observations are session-wide, NOT branch-sensitive conversation state.
	for (const entry of entries) {
		const e = object(entry);
		if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
		const d = object(e.data);
		if (d?.version === 1 && d.sessionId === sessionId && typeof d.account === "string" &&
			/^[a-f0-9]{64}$/.test(d.account) && validSample(d.baseline) && validSample(d.latest) &&
			finite(d.delta) && d.delta >= 0 && typeof d.unobserved === "boolean") {
			restored = structuredClone(d) as unknown as QuotaState;
		}
	}
	return restored;
}
export function acceptSample(previous: QuotaState | undefined, sample: WeekSample,
	sessionId: string, account: string): QuotaState {
	if (!previous || previous.sessionId !== sessionId || previous.account !== account) {
		return { version: 1, sessionId, account, baseline: sample, latest: sample, delta: 0, unobserved: false };
	}
	const sameWindow = previous.latest.resetAt === sample.resetAt;
	const fell = sample.used < previous.latest.used;
	return {
		...previous, latest: sample,
		delta: previous.delta + (sameWindow ? Math.max(0, sample.used - previous.latest.used) : sample.used),
		unobserved: previous.unobserved || !sameWindow || fell,
	};
}
export function decimal(n: number): string { return n.toFixed(1).replace(/\.0$/, ""); }
export function quotaText(state: QuotaState | undefined, failed: boolean, now: number): string {
	if (!state) return failed ? "wk unavailable" : "wk …";
	const stale = failed || now >= state.latest.resetAt || now - state.latest.fetchedAt >= CACHE_MS;
	const delta = state.unobserved ? `~+${decimal(state.delta)}pp unobserved` : `+${decimal(state.delta)}pp`;
	return `wk ${decimal(state.latest.used)}% (${delta})${stale ? " stale" : ""}`;
}
export function resetText(state: QuotaState | undefined, now: number): string {
	if (!state) return "";
	const remaining = state.latest.resetAt - now;
	if (remaining <= 0) return "󰥔 reset due";
	const minutes = Math.ceil(remaining / 60_000);
	if (minutes >= 1440) return `󰥔 ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
	if (minutes >= 60) return `󰥔 ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `󰥔 ${minutes}m`;
}
export function kvText(completedAt: number | undefined, now: number): string {
	if (completedAt === undefined) return "";
	const remaining = KV_IDLE_MS - Math.max(0, now - completedAt);
	if (remaining > KV_WARNING_MS) return "";
	if (remaining <= 0) return "KV expired";
	const seconds = Math.ceil(remaining / 1000);
	return `KV ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Observed generation interval, not wall-clock request duration or text-token estimation. */
export class OutputMetrics {
	private first: number | undefined;
	private last: number | undefined;
	private reasoningObserved = false;
	private touch(now: number, reasoning = false) {
		this.first ??= now;
		this.last = now;
		this.reasoningObserved ||= reasoning;
	}
	normalized(event: unknown, now: number) {
		const e = object(event);
		if (e && ["text_delta", "thinking_delta", "toolcall_delta"].includes(String(e.type)) &&
			typeof e.delta === "string" && e.delta.length > 0) {
			this.touch(now, e.type === "thinking_delta");
		}
	}
	raw(event: unknown, now: number) {
		const e = object(event);
		if (!e || typeof e.type !== "string") return;
		const item = object(e.item);
		// Reasoning can be hidden from normalized thinking summaries. These boundaries
		// observe its interval without treating response.completed (usage tail) as output.
		if ((e.type === "response.output_item.added" || e.type === "response.output_item.done") &&
			(item?.type === "reasoning" || item?.type === "function_call")) {
			this.touch(now, item.type === "reasoning");
		} else if (/^response\.(output_text|reasoning_text|reasoning_summary_text|function_call_arguments)\.delta$/.test(e.type) &&
			typeof e.delta === "string" && e.delta.length > 0) {
			this.touch(now, e.type.includes("reasoning"));
		}
	}
	finish(message: unknown): number | undefined {
		const m = object(message), usage = object(m?.usage);
		if (!m || !["stop", "length", "toolUse"].includes(String(m.stopReason)) ||
			!finite(usage?.output) || usage.output <= 0 ||
			this.first === undefined || this.last === undefined || this.last <= this.first ||
			(finite(usage.reasoning) && usage.reasoning > 0 && !this.reasoningObserved)) return undefined;
		return usage.output / ((this.last - this.first) / 1000);
	}
}

/** Porcelain v1 -z: filenames may contain newlines and renames consume two records. */
export function gitSummary(stdout: string): string {
	let staged = 0, modified = 0, unknown = 0, conflict = 0, ahead = 0, behind = 0;
	const records = stdout.split("\0");
	for (let i = 0; i < records.length; i++) {
		const line = records[i];
		if (!line) continue;
		if (line.startsWith("## ")) {
			ahead = Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
			behind = Number(line.match(/behind (\d+)/)?.[1] ?? 0);
			continue;
		}
		const xy = line.slice(0, 2);
		if (xy === "??") unknown++;
		else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) conflict++;
		else {
			if (xy[0] && xy[0] !== " " && xy[0] !== "!") staged++;
			if (xy[1] && xy[1] !== " " && xy[1] !== "!") modified++;
		}
		if (xy.includes("R") || xy.includes("C")) i++;
	}
	return [ahead && `ahead:${ahead}`, behind && `behind:${behind}`, conflict && `!${conflict}`,
		staged && `+${staged}`, modified && `~${modified}`, unknown && `?${unknown}`].filter(Boolean).join(" ") || "clean";
}
