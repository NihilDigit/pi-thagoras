import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GIT_ICON } from "./core.ts";

export type FooterColorRole = "accent" | "text" | "dim" | "muted" | "success" | "warning" | "error";

/** Status values are data, never terminal commands. Keep text, remove emoji/dot separators. */
export function plain(text: string): string {
	return stripTerminalSequences(text).replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u00B7\u2022\u25CF]/gu, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}
export function statusText(statuses: ReadonlyMap<string, string>): string {
	const parts: string[] = [];
	for (const [key, value] of statuses) {
		if (key === "tps" || key === "compact-warning" || key.startsWith("remote-pi:")) continue;
		const text = plain(value);
		if (text) parts.push(text);
	}
	return parts.join("  ");
}
function columns(width: number): number { return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0; }
/** ANSI-safe single row. Never emit a padding gap that by itself exceeds width. */
export function row(left: string, right: string, width: number, rightFraction = 0.58): string {
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
	bar?: string;
	context: string;
	model: string;
	thinking: string;
	dim?: (text: string) => string;
	color?: (role: FooterColorRole, text: string) => string;
	quota: string;
	reset: string;
	secondaryQuota?: string;
	tps?: number;
	statuses: ReadonlyMap<string, string>;
}

function stylePrimaryQuota(
	raw: string,
	paint: ((role: FooterColorRole, text: string) => string) | undefined,
	dim: (text: string) => string,
): string {
	if (!paint) return raw;
	const m = raw.match(/^(\S+)\s+([\d.]+%)(\s+\([^)]+\))?$/);
	if (!m) return dim(raw);
	const [, icon, pct, delta] = m;
	const num = parseFloat(pct!);
	const pctRole: FooterColorRole = num >= 95 ? "error" : num >= 80 ? "warning" : "text";
	const parts = [paint("accent", icon!), paint(pctRole, pct!)];
	if (delta) parts.push(dim(delta.trim()));
	return parts.join(" ");
}

function styleSecondaryQuota(
	raw: string,
	paint: ((role: FooterColorRole, text: string) => string) | undefined,
	dim: (text: string) => string,
): string {
	if (!paint) return dim(raw);
	const m = raw.match(/^(\S+)\s+(.+)$/);
	if (!m) return dim(raw);
	return `${paint("muted", m[1]!)} ${dim(m[2]!)}`;
}

function styleContextValue(
	raw: string,
	paint: ((role: FooterColorRole, text: string) => string) | undefined,
	dim: (text: string) => string,
): string {
	if (!paint) return dim(raw);
	const slash = raw.indexOf("/");
	if (slash < 0) return paint("muted", raw);
	return `${paint("muted", raw.slice(0, slash))}${dim(raw.slice(slash))}`;
}

export function formatGitStatus(rawGit: string, paint: (role: FooterColorRole, text: string) => string): string {
	const cleaned = plain(rawGit);
	if (!cleaned) return "";
	if (cleaned === "clean") return paint("success", GIT_ICON.clean);
	const out: string[] = [];
	for (const token of cleaned.split(" ")) {
		if (!token) continue;
		let m: RegExpMatchArray | null;
		if ((m = token.match(/^ahead:(\d+)$/))) out.push(paint("success", `${GIT_ICON.ahead} ${m[1]}`));
		else if ((m = token.match(/^behind:(\d+)$/))) out.push(paint("warning", `${GIT_ICON.behind} ${m[1]}`));
		else if ((m = token.match(/^!(\d+)$/))) out.push(paint("error", `${GIT_ICON.conflict} ${m[1]}`));
		else if ((m = token.match(/^\+(\d+)$/))) out.push(paint("success", `${GIT_ICON.staged} ${m[1]}`));
		else if ((m = token.match(/^~(\d+)$/))) out.push(paint("warning", `${GIT_ICON.modified} ${m[1]}`));
		else if ((m = token.match(/^\?(\d+)$/))) out.push(paint("muted", `${GIT_ICON.untracked} ${m[1]}`));
		else out.push(paint("dim", token));
	}
	return out.join(" ");
}

export function renderFooter(view: FooterView, width: number): string[] {
	width = columns(width);
	if (!width) return [""];
	const dim = view.dim ?? ((text: string) => text);
	const paint = view.color ?? ((role: FooterColorRole, text: string) => (role === "dim" ? dim(text) : dim(text)));
	let path = plain(view.cwd.replace(/\\/g, "/"));
	const home = view.home?.replace(/\\/g, "/");
	if (home && (path === home || path.startsWith(home + "/"))) path = "~" + path.slice(home.length);
	const cleanBranch = view.branch ? plain(view.branch) : "";
	const branchText = cleanBranch ? paint("accent", `${GIT_ICON.branch} ${cleanBranch}`) : "";
	const git = formatGitStatus(view.git, paint);
	const contextRaw = plain(view.context);
	const contextTitle = dim("Context");
	const contextVal = styleContextValue(contextRaw, view.color, dim);
	const contextPart = view.bar ? `${contextTitle} ${view.bar} ${contextVal}` : `${contextTitle} ${contextVal}`;
	const statuses = statusText(view.statuses);
	const statusPart = statuses ? dim(statuses) : "";
	const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
	const sep = dim("│");
	const joinGroups = (...groups: string[]) => groups.filter(Boolean).join(` ${sep} `);

	// Right side grouped with clear hierarchy: [Quota] │ [TPS] │ [Statuses] │ [Context]
	const rawQuota = view.quota;
	const primary = rawQuota.match(/^\S+ [\d.]+%/)?.[0];
	const compactRaw = primary ?? rawQuota;
	const quota = stylePrimaryQuota(rawQuota, view.color, dim);
	const compactQuota = stylePrimaryQuota(compactRaw, view.color, dim);
	const reset = view.reset ? dim(view.reset) : "";
	const secQuota = view.secondaryQuota ? styleSecondaryQuota(view.secondaryQuota, view.color, dim) : "";
	const rate = view.tps !== undefined && Number.isFinite(view.tps)
		? (view.color ? `${paint("muted", view.tps.toFixed(1))} ${dim("tok/s")}` : dim(`${view.tps.toFixed(1)} tok/s`))
		: "";

	const quotaWithReset = join(quota, reset);

	const rightCandidates = [
		joinGroups(quotaWithReset, secQuota, rate, statusPart, contextPart),
		joinGroups(quotaWithReset, secQuota, rate, contextPart),
		joinGroups(quotaWithReset, secQuota, contextPart),
		joinGroups(quotaWithReset, rate, contextPart),
		joinGroups(quotaWithReset, contextPart),
		joinGroups(quota, contextPart),
		quotaWithReset,
		quota,
		compactQuota,
	];
	const rightLimit = width < 28 ? width : Math.ceil(width * 0.68);
	const right = rightCandidates.find(s => visibleWidth(s) <= rightLimit)
		?? rightCandidates.find(s => visibleWidth(s) <= width)
		?? truncateToWidth(compactQuota, width, "");

	const piLogo = view.color ? paint("accent", "\udb80\ude4b") : "π";
	const gitGroup = join(branchText, git);
	const leftSep = view.color && gitGroup ? ` ${sep} ` : " ";
	const leftLimit = Math.max(0, width - visibleWidth(right) - (right ? 2 : 0));
	const fixedLeft = gitGroup ? `${piLogo}${leftSep}${gitGroup}` : piLogo;
	const pathBudget = leftLimit - visibleWidth(fixedLeft) - 1;
	const shortPath = tailPath(path, Math.max(0, pathBudget));
	const withPath = (p: string) => gitGroup ? `${join(piLogo, p)}${leftSep}${gitGroup}` : join(piLogo, p);
	const leftCandidates = [
		withPath(dim(path)),
		shortPath ? withPath(dim(shortPath)) : "",
		fixedLeft,
		gitGroup,
		join(piLogo, branchText),
		branchText,
		git,
		piLogo,
	].filter(Boolean);
	const left = leftCandidates.find(s => visibleWidth(s) <= leftLimit) ?? "";
	return [left ? row(left, right, width, 0.68) : truncateToWidth(right, width, "")];
}
export function formatCapacity(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n) || n <= 0) return "?";
	return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
}
