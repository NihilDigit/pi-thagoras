import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Status values are data, never terminal commands. Keep text, remove emoji/dot separators. */
export function plain(text: string): string {
	return stripTerminalSequences(text).replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u00B7\u2022\u25CF]/gu, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}
export function statusText(statuses: ReadonlyMap<string, string>): string {
	const parts: string[] = [];
	for (const key of ["remote-pi:relay", "remote-pi:session", "remote-pi:peer-active"]) {
		const value = statuses.get(key);
		if (!value) continue;
		const text = plain(value);
		if (text) parts.push(`${key === "remote-pi:relay" ? "" : key === "remote-pi:session" ? "" : ""} ${text}`);
	}
	for (const [key, value] of statuses) {
		if (key.startsWith("remote-pi:") && ["remote-pi:relay", "remote-pi:session", "remote-pi:peer-active"].includes(key)) continue;
		const text = plain(value);
		if (text) parts.push(text);
	}
	return parts.join("  ");
}
function columns(width: number): number { return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0; }
/** ANSI-safe single row. Never emit a padding gap that by itself exceeds width. */
export function row(left: string, right: string, width: number, rightFraction = 0.55): string {
	width = columns(width);
	if (!width) return "";
	if (!left) return truncateToWidth(right, width, "");
	if (!right) return truncateToWidth(left, width, "");
	if (visibleWidth(left) + visibleWidth(right) + 2 <= width) {
		return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
	}
	const rb = Math.min(visibleWidth(right), Math.ceil(width * rightFraction));
	const gap = width - rb > 1 ? 1 : 0;
	const l = truncateToWidth(left, Math.max(0, width - rb - gap), "");
	const r = truncateToWidth(right, rb, "");
	return truncateToWidth(l + " ".repeat(Math.max(0, width - visibleWidth(l) - visibleWidth(r))) + r, width, "");
}
function tailPath(path: string, budget: number): string {
	if (visibleWidth(path) <= budget) return path;
	if (budget <= 1) return budget === 1 ? "…" : "";
	return "…" + sliceByColumn(path, visibleWidth(path) - budget + 1, budget - 1);
}
export interface FooterView {
	cwd: string;
	home?: string;
	branch?: string | null;
	git: string;
	context: string;
	model: string;
	thinking: string;
	dim?: (text: string) => string;
	quota: string;
	reset: string;
	tps?: number;
	statuses: ReadonlyMap<string, string>;
	kv: string;
}
export function renderFooter(view: FooterView, width: number): string[] {
	width = columns(width);
	const dim = view.dim ?? ((text: string) => text);
	const model = plain(view.model || "no-model");
	const right1 = [model, view.thinking ? dim(plain(view.thinking)) : ""].filter(Boolean).join(" ");
	let path = plain(view.cwd.replace(/\\/g, "/"));
	const home = view.home?.replace(/\\/g, "/");
	if (home && (path === home || path.startsWith(home + "/"))) path = "~" + path.slice(home.length);
	const branch = view.branch ? `(${plain(view.branch)})` : "";
	const context = dim(plain(view.context));
	const git = view.git ? dim(plain(view.git)) : "";
	const branchText = branch ? dim(branch) : "";
	const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
	const full = join("π", dim(path), branchText, git, context);
	const budget = width - visibleWidth(join("π", branchText, git, context, right1)) - 3;
	const shortPath = tailPath(path, Math.max(0, budget));
	const choices = [full, join("π", shortPath ? dim(shortPath) : "", branchText, git, context),
		join("π", branchText, context), join("π", context), context];
	const left1 = choices.find(s => visibleWidth(s) + visibleWidth(right1) + 2 <= width) ?? "";
	// At very small widths the model wins the first line, the quota wins the second.
	const first = left1 ? row(left1, right1, width) : truncateToWidth(right1, width, "");
	const rate = view.tps !== undefined && Number.isFinite(view.tps) ? dim(`${view.tps.toFixed(1)} tok/s`) : "";
	const statuses = statusText(view.statuses);
	const right2 = [statuses ? dim(statuses) : "", view.kv].filter(Boolean).join("  ");
	const quota = view.quota;
	const primary = quota.match(/^wk [\d.]+%/)?.[0];
	const stale = quota.endsWith(" stale");
	const compact = primary ? join(primary, stale ? "stale" : "") : quota;
	const quotaChoices = [quota, compact, stale ? "wk stale" : compact];
	const fallback = quotaChoices.find(s => visibleWidth(s) <= width) ?? (stale ? "wk stale" : compact);
	const reset = view.reset ? dim(view.reset) : "";
	const extras = [join(quota, reset, rate), join(quota, reset), quota];
	const left2 = extras.find(s => visibleWidth(s) + (right2 ? visibleWidth(right2) + 2 : 0) <= width) ?? fallback;
	// Preserve the quota ahead of connection details; drop right-side fields first.
	const rightBudget = Math.max(0, width - visibleWidth(left2) - 2);
	const second = rightBudget > 0 ? row(left2, truncateToWidth(right2, rightBudget, ""), width, 0.3)
		: truncateToWidth(left2, width, "");
	return [first, second];
}
export function formatCapacity(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n) || n <= 0) return "?";
	return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
}
