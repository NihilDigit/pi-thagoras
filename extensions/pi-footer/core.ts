/** Footer-only state. Independently implemented; no upstream footer code is copied. */
export const WEEK_SECONDS = 604800;
export const WEEK_MINUTES = 10080;
export const CACHE_MS = 5 * 60_000;
export const RETRY_BASE_MS = 60_000;
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

/** Parse headless `codex app-server` `account/rateLimits/read` response. */
export function parseCodexRateLimits(body: unknown, now: number): { accountId?: string; sample: WeekSample } | undefined {
	const root = object(object(body)?.result) ?? object(body);
	const byId = object(root?.rateLimitsByLimitId);
	const limit = object(root?.rateLimits) ?? object(byId?.codex);
	if (!limit) return undefined;
	for (const name of ["primary", "secondary", "primary_window", "secondary_window"]) {
		const window = object(limit[name]);
		if (!window) continue;
		const mins = window.windowDurationMins ?? window.window_duration_mins;
		const secs = window.limitWindowSeconds ?? window.limit_window_seconds;
		if (mins !== WEEK_MINUTES && secs !== WEEK_SECONDS) continue;
		const used = window.usedPercent ?? window.used_percent;
		const reset = window.resetsAt ?? window.reset_at;
		if (!finite(used) || used < 0 || used > 100 || !finite(reset) || reset <= 0) continue;
		const accountId = typeof root?.accountId === "string" && root.accountId.trim() ? root.accountId.trim() : undefined;
		return { accountId, sample: { used, resetAt: reset * 1000, fetchedAt: now } };
	}
	return undefined;
}

export function agyQuotaBucketId(modelId?: string): "gemini-weekly" | "3p-weekly" {
	return /^(claude|gpt)/i.test((modelId ?? "").trim()) ? "3p-weekly" : "gemini-weekly";
}

/** Parse headless `agy -p "/usage" --output-format json` response for the active model group. */
export function parseAgyUsage(body: unknown, modelId: string | undefined, now: number): { bucketId: string; sample: WeekSample } | undefined {
	const root = object(body);
	const data = object(object(root?.command)?.data) ?? root;
	const groups = Array.isArray(data?.groups) ? data.groups : undefined;
	if (!groups) return undefined;
	const targetBucket = agyQuotaBucketId(modelId);
	const want3p = targetBucket === "3p-weekly";
	for (const rawGroup of groups) {
		const group = object(rawGroup);
		const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
		const groupName = typeof group?.name === "string" ? group.name : typeof group?.displayName === "string" ? group.displayName : "";
		const groupMatches = want3p ? /claude|gpt/i.test(groupName) : /gemini/i.test(groupName);
		for (const rawBucket of buckets) {
			const bucket = object(rawBucket);
			if (!bucket) continue;
			const id = typeof bucket.id === "string" ? bucket.id : typeof bucket.bucketId === "string" ? bucket.bucketId : "";
			const win = typeof bucket.window === "string" ? bucket.window.toLowerCase() : "";
			if (win !== "weekly" && win !== "week" && !id.endsWith("-weekly")) continue;
			if (id !== targetBucket && !groupMatches) continue;
			const rem = bucket.remaining_fraction ?? bucket.remainingFraction;
			const resetRaw = bucket.reset_time ?? bucket.resetTime;
			const resetAt = typeof resetRaw === "string" ? Date.parse(resetRaw) : NaN;
			if (!finite(rem) || rem < 0 || rem > 1 || !finite(resetAt) || resetAt <= 0) continue;
			const used = Math.round(Math.max(0, Math.min(100, (1 - rem) * 100)) * 10) / 10;
			return { bucketId: id || targetBucket, sample: { used, resetAt, fetchedAt: now } };
		}
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
export function restoreQuota(entries: readonly unknown[], sessionId: string, authProvider?: string): QuotaState | undefined {
	let restored: QuotaState | undefined;
	// Account observations are session-wide, NOT branch-sensitive conversation state.
	for (const entry of entries) {
		const e = object(entry);
		if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
		const d = object(e.data);
		if (d?.version === 1 && d.sessionId === sessionId && typeof d.account === "string" &&
			/^[a-f0-9]{64}$/.test(d.account) && validSample(d.baseline) && validSample(d.latest) &&
			finite(d.delta) && d.delta >= 0 && typeof d.unobserved === "boolean" &&
			(authProvider === undefined || d.authProvider === authProvider)) {
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
	const sameWindow = Math.abs(sample.resetAt - previous.latest.resetAt) < 3_600_000;
	const fell = sample.used < previous.latest.used;
	return {
		...previous, latest: sample,
		delta: previous.delta + (sameWindow ? Math.max(0, sample.used - previous.latest.used) : sample.used),
		unobserved: previous.unobserved || !sameWindow || fell,
	};
}
export function decimal(n: number): string { return n.toFixed(1).replace(/\.0$/, ""); }
export const ICON_OPENAI = "\uec81";
export const ICON_CLAUDE = "\uec82";
export const ICON_GOOGLE = "\uf1a0";
export const GIT_ICON = {
	branch: "\ue725",
	clean: "\uf058",
	ahead: "\uf062",
	behind: "\uf063",
	staged: "\uf055",
	modified: "\uf192",
	untracked: "\uf059",
	conflict: "\uf071",
} as const;

export function quotaText(state: QuotaState | undefined, failed: boolean, _now?: number, label = "wk"): string {
	if (!state) return failed ? `${label} unavailable` : `${label} …`;
	return `${label} ${decimal(state.latest.used)}% (+${decimal(state.delta)}%)`;
}
export function secondaryQuotaText(state: QuotaState | undefined, failed: boolean, label: string): string {
	if (!state) return failed ? `${label} --` : `${label} …`;
	return `${label} ${decimal(state.latest.used)}%`;
}
export function contextBar(percent: number | null | undefined, cells = 8): string {
	const clamped = percent != null && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
	const filled = percent == null || !Number.isFinite(percent) ? 0
		: clamped > 0 ? Math.max(1, Math.round((clamped / 100) * cells)) : 0;
	let out = "";
	for (let i = 0; i < cells; i++) {
		const full = i < filled;
		out += i === 0 ? (full ? "\uee03" : "\uee00")
			: i === cells - 1 ? (full ? "\uee05" : "\uee02")
			: (full ? "\uee04" : "\uee01");
	}
	return out;
}
export function resetText(state: QuotaState | undefined, now: number): string {
	if (!state) return "";
	const remaining = state.latest.resetAt - now;
	if (remaining <= 0) return "󰥔 reset due";
	const minutes = Math.ceil(remaining / 60_000);
	if (minutes >= 60) return `󰥔 ${Math.floor(minutes / 60)}h`;
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
	constructor(private readonly requestStart?: number) {}
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
			!finite(usage?.output) || usage.output <= 0) return undefined;
		if (finite(m.durationMs) && m.durationMs >= 250) {
			return usage.output / (m.durationMs / 1000);
		}
		const hasReasoning = finite(usage.reasoning) && usage.reasoning > 0;
		const streamSpanMs = this.first !== undefined && this.last !== undefined ? this.last - this.first : 0;
		if (streamSpanMs >= 250 && (!hasReasoning || this.reasoningObserved)) {
			return usage.output / (streamSpanMs / 1000);
		}
		return undefined;
	}
	finishTtft(message: unknown): number | undefined {
		const m = object(message);
		if (!m || !["stop", "length", "toolUse"].includes(String(m.stopReason))) return undefined;
		if (this.requestStart !== undefined && this.first !== undefined && this.first >= this.requestStart) {
			return (this.first - this.requestStart) / 1000;
		}
		if (finite(m.durationMs) && m.durationMs > 0) {
			const streamSpanMs = this.first !== undefined && this.last !== undefined && this.last > this.first ? this.last - this.first : 0;
			return Math.max(0, m.durationMs - streamSpanMs) / 1000;
		}
		return undefined;
	}
}

/** Extract branch name from porcelain v1 --branch header as fallback when watcher branch is unavailable. */
export function gitBranchFromPorcelain(stdout: string): string | undefined {
	const first = stdout.split("\0", 1)[0];
	if (!first?.startsWith("## ")) return undefined;
	const head = first.slice(3).trim();
	if (!head) return undefined;
	if (head.startsWith("HEAD (")) return "HEAD";
	const unborn = head.match(/^(?:No commits yet on|Initial commit on) (.+)$/);
	if (unborn?.[1]) return unborn[1].trim();
	const branch = head.split("...")[0]?.replace(/\s+\[.*$/, "").trim();
	return branch || undefined;
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
