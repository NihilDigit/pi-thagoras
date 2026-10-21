import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { row } from "./pi-footer/layout.ts";

export const COMPACT_THRESHOLD_TOKENS = 512_000;
export const MAX_LINE_CHARS = 2_000;
export const MAX_TOOL_TEXT_CHARS = 24_000;

const ICON_GOOGLE = "\uf1a0";
const ICON_OPENAI = "\uec81";
const ICON_CLAUDE = "\uec82";
const ICON_MODEL = "\uec19";
const ICON_THINKING = "\uf400";
const ICON_ALLOW = "\uf058";
const ICON_DENY = "\uf071";
const SPINNER_FRAMES = [
	"\ue3e3",
	"\ue3c8", "\ue3c9", "\ue3ca", "\ue3cb", "\ue3cc", "\ue3cd",
	"\ue3ce",
	"\ue3cf", "\ue3d0", "\ue3d1", "\ue3d2", "\ue3d3", "\ue3d4",
	"\ue3d5",
	"\ue3d6", "\ue3d7", "\ue3d8", "\ue3d9", "\ue3da", "\ue3db",
	"\ue3dc",
	"\ue3dd", "\ue3de", "\ue3df", "\ue3e0", "\ue3e1", "\ue3e2",
] as const;

function capitalize(word: string): string {
	return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : "";
}

export function formatShortModelName(rawModelId: string): string {
	const base = (rawModelId || "no-model").trim().split("/").at(-1) ?? "no-model";
	const stripped = base.replace(/-(?:minimal|low|medium|high|xhigh|max|thinking)$/i, "");
	const gemini = stripped.match(/^gemini-[\d.]+-([a-z0-9]+)/i);
	if (gemini?.[1]) return `Gemini-${capitalize(gemini[1])}`;
	const gptRole = stripped.match(/^gpt-[\d.]+-([a-z0-9]+)/i);
	if (gptRole?.[1]) return `GPT-${capitalize(gptRole[1])}`;
	const gptVer = stripped.match(/^gpt-([\d.]+)$/i);
	if (gptVer?.[1]) return `GPT-${gptVer[1]}`;
	const claude = stripped.match(/^claude-([a-z]+)/i);
	if (claude?.[1]) return `Claude-${capitalize(claude[1])}`;
	return stripped || "no-model";
}

function modelIcon(rawModelId: string): string {
	const id = (rawModelId || "").toLowerCase();
	if (id.includes("gemini")) return ICON_GOOGLE;
	if (id.includes("claude")) return ICON_CLAUDE;
	if (id.includes("gpt") || id.includes("codex") || /^o\d/.test(id)) return ICON_OPENAI;
	return ICON_MODEL;
}

function agentModelBadge(agentName: string, rawModel?: string): string {
	if (rawModel) return `${modelIcon(rawModel)} ${formatShortModelName(rawModel)}`;
	const lower = agentName.toLowerCase();
	if (lower === "flash") return `${ICON_GOOGLE} Gemini-Flash`;
	if (lower === "argon") return `${ICON_GOOGLE} Gemini-Argon`;
	if (lower === "astra") return `${ICON_OPENAI} GPT-Astra`;
	if (lower === "sol") return `${ICON_OPENAI} GPT-Sol`;
	return "";
}

function thinkingColorRole(level: string): string {
	switch (level.toLowerCase()) {
		case "off": return "thinkingOff";
		case "minimal": return "thinkingMinimal";
		case "low": return "thinkingLow";
		case "medium": return "thinkingMedium";
		case "high": return "thinkingHigh";
		case "xhigh": return "thinkingXhigh";
		case "max": return "thinkingMax";
		default: return "muted";
	}
}

function formatElapsed(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatTok(tokens: number | undefined): string {
	if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
	if (tokens < 1000) return `${Math.round(tokens)} tok`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tok`;
	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tok`;
}

export function sanitizeToolText(text: string): { text: string; changed: boolean } {
	let changed = false;
	const out = text.replace(
		/("(?:encrypted_content|thinkingSignature|textSignature)"\s*:\s*")([^"]{256,})(")/g,
		(_m, pre: string, body: string, post: string) => {
			changed = true;
			return `${pre}[${body.length} chars omitted]${post}`;
		},
	);
	return { text: out, changed };
}

interface TopRightState {
	tokens: number | undefined;
	model: string;
	thinking: string;
	subagentLabel: string;
	reviewingLabel: string;
	spinnerFrame: string;
	fg?: (color: string, text: string) => string;
}

class TopRightStatusEditor extends CustomEditor {
	constructor(
		tui: any,
		private readonly editorTheme: any,
		keybindings: any,
		private readonly getState: () => TopRightState,
		private readonly onSubagentNav: (data: string, isEmpty: boolean) => boolean,
		options?: any,
	) {
		super(tui, editorTheme, keybindings, { ...options, embedWorkingStatus: true });
	}

	override handleInput(data: string): void {
		if (this.onSubagentNav(data, this.getText() === "")) {
			return;
		}
		super.handleInput(data);
	}

	override renderTopBorder(width: number, hiddenLineCount: number): string {
		const indicator = (this as any).workingStatusIndicator;
		(this as any).workingStatusIndicator = undefined;
		let base: string;
		try {
			base = super.renderTopBorder(width, hiddenLineCount);
		} finally {
			(this as any).workingStatusIndicator = indicator;
		}
		if (width < 24) return base;
		const { model, thinking, subagentLabel, reviewingLabel, spinnerFrame, fg: stateFg } = this.getState();
		const fg = (color: string, text: string) => {
			if (typeof stateFg === "function") return stateFg(color, text);
			if (typeof this.editorTheme?.fg === "function") return this.editorTheme.fg(color, text);
			return text;
		};
		const workingPart =
			indicator && typeof indicator.renderInBorder === "function"
				? String(indicator.renderInBorder(Math.max(12, Math.floor(width * 0.35)))).trim()
				: "";
		const extraLabels = [reviewingLabel, subagentLabel].filter(Boolean).join("  ");
		let leftStatus = "";
		if (workingPart && extraLabels) {
			leftStatus = `${workingPart} ${fg("dim", "│")} ${this.borderColor(extraLabels)}`;
		} else if (workingPart) {
			leftStatus = workingPart;
		} else if (extraLabels) {
			leftStatus = `${fg("accent", spinnerFrame)} ${this.borderColor(extraLabels)}`;
		}
		const leftBrand = leftStatus
			? `${leftStatus} `
			: this.borderColor("\u03c0 ");
		const leftBrandWidth = visibleWidth(leftBrand);
		const rawModel = model || "no-model";
		const shortModel = formatShortModelName(rawModel);
		const icon = modelIcon(rawModel);
		const styledModel = fg("text", `${icon} ${shortModel}`);
		const styledThinking = thinking
			? fg(thinkingColorRole(thinking), `${ICON_THINKING} ${thinking}`)
			: "";
		const rightContent = [styledModel, styledThinking].filter(Boolean).join("  ");
		const rightBadge = ` ${rightContent} ${this.borderColor("─")}`;
		const rightBadgeWidth = visibleWidth(rightBadge);
		if (width <= leftBrandWidth + rightBadgeWidth + 4) return base;
		const middleWidth = Math.max(1, width - leftBrandWidth - rightBadgeWidth);
		return leftBrand + this.borderColor("─".repeat(middleWidth)) + rightBadge;
	}
}

interface SubagentItem {
	key: string;
	runId: string;
	agent: string;
	model?: string;
	state: string;
	startedAt: number;
	endedAt?: number;
	tokens?: number;
	asyncDir?: string;
	stepIndex?: number;
	taskPreview?: string;
}

const TERMINAL_STATES = new Set([
	"complete",
	"completed",
	"failed",
	"stopped",
	"error",
	"rejected",
	"partial",
	"cancelled",
]);

function renderCompactAutoReviewLines(data: any, theme: any, width: number): string[] {
	const fg = (role: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(role, text) : text);
	const sep = fg("dim", "│");
	const members = Array.isArray(data?.members) ? data.members : undefined;
	const rawLines: string[] = Array.isArray(data?.lines) ? data.lines : [];
	const outcome: string = data?.outcome ?? "allow";
	const allowed = outcome === "allow" || outcome === "auto_confirm" || outcome === "needs_confirmation";
	const glyph = allowed ? fg("success", ICON_ALLOW) : fg("warning", ICON_DENY);
	const statusWord = allowed ? fg("success", "allowed") : outcome === "defer" ? fg("warning", "deferred") : fg("warning", "denied");

	let detail = "";
	let meta = "";
	let recovery = "";
	if (members && members.length > 0) {
		const m = members[0]!;
		const surface = m.surface || "tool";
		const target = m.target || data.fullCommand || "";
		detail = [surface, target].filter(Boolean).join(" · ");
		if (!allowed && m.rationale) detail = `${detail ? `${detail} — ` : ""}${m.rationale}`;
		if (!allowed && typeof m.recoveryCommand === "string") recovery = m.recoveryCommand;
		if (typeof m.durationMs === "number") meta = `${(m.durationMs / 1000).toFixed(1)}s`;
	} else if (rawLines.length > 0) {
		const head = rawLines[0] ?? "";
		const surface = head.split("·").map((s: string) => s.trim()).at(-1) ?? "";
		const body = rawLines[1] ?? "";
		detail = [surface && surface !== "allowed" && surface !== "denied" ? surface : "", body].filter(Boolean).join(" · ");
		for (const line of rawLines.slice(1)) {
			if (line.startsWith("use /auto-review-")) recovery = line.replace(/^use\s+/, "").replace(/\s+for one exact retry$/, "");
			const dur = line.match(/\b(\d+(?:\.\d+)?(?:ms|s))\b/);
			if (dur?.[1]) meta = dur[1];
		}
	}

	const leftParts = [
		`${glyph} ${fg("muted", "Auto-review")}`,
		statusWord,
		detail ? fg("dim", truncateToWidth(detail.replace(/\s+/g, " ").trim(), Math.max(20, width - 38), "…")) : "",
		recovery ? fg("accent", recovery) : "",
	].filter(Boolean);
	const left = leftParts.join(` ${sep} `);
	const right = meta ? fg("dim", meta) : "";
	return [right ? row(left, right, width, 0.25) : truncateToWidth(left, width, "…")];
}

export default function (pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | undefined;
	let currentModelId = "";
	let requestRender = () => {};
	const subagentItems = new Map<string, SubagentItem>();
	let drawerOpen = false;
	let selectedDrawerKey = "";
	let reviewingActive = false;
	let spinnerIndex = 0;
	let tickCount = 0;
	let animTimer: ReturnType<typeof setInterval> | undefined;

	pi.registerEntryRenderer("pi-auto-review", (entry: any, _options: any, theme: any) => {
		if (!entry?.data) return undefined;
		return {
			render(width: number) {
				return renderCompactAutoReviewLines(entry.data, theme, width);
			},
			invalidate() {},
		};
	});

	function deduplicatedItems(onlyRunning: boolean): SubagentItem[] {
		const seen = new Set<string>();
		const out: SubagentItem[] = [];
		for (const item of subagentItems.values()) {
			if (onlyRunning && TERMINAL_STATES.has(item.state.toLowerCase())) continue;
			const identity = `${item.runId || item.key}:${item.stepIndex ?? 0}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			out.push(item);
		}
		return out;
	}

	function runningItems(): SubagentItem[] {
		return deduplicatedItems(true);
	}

	function drawerCandidates(): SubagentItem[] {
		const active = deduplicatedItems(true);
		if (active.length > 0) return active;
		return deduplicatedItems(false).slice(-6);
	}

	function syncTimer() {
		const needTimer = runningItems().length > 0 || reviewingActive;
		if (needTimer && !animTimer) {
			animTimer = setInterval(() => {
				spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
				tickCount++;
				if (tickCount % 20 === 0) {
					for (const item of subagentItems.values()) {
						if (!item.asyncDir || TERMINAL_STATES.has(item.state.toLowerCase())) continue;
						try {
							const statusPath = join(item.asyncDir, "status.json");
							if (existsSync(statusPath)) {
								const parsed = JSON.parse(readFileSync(statusPath, "utf8"));
								if (typeof parsed?.totalTokens === "number") item.tokens = parsed.totalTokens;
								if (Array.isArray(parsed?.steps) && item.stepIndex !== undefined) {
									const step = parsed.steps[item.stepIndex];
									if (typeof step?.status === "string") item.state = step.status;
									if (typeof step?.tokens === "number") item.tokens = step.tokens;
								} else if (typeof parsed?.state === "string") {
									item.state = parsed.state;
								}
								if (TERMINAL_STATES.has(item.state.toLowerCase()) && !item.endedAt) {
									item.endedAt = Date.now();
								}
							}
						} catch {}
					}
					if (runningItems().length === 0) drawerOpen = false;
					if (runningItems().length === 0 && !reviewingActive) syncTimer();
				}
				if (activeCtx?.mode === "tui") requestRender();
			}, 35);
			animTimer.unref?.();
		} else if (!needTimer && animTimer) {
			clearInterval(animTimer);
			animTimer = undefined;
			if (activeCtx?.mode === "tui") requestRender();
		}
	}

	function currentSubagentLabel(): string {
		const active = runningItems();
		if (active.length === 0) return "";
		const counts = new Map<string, number>();
		for (const item of active) {
			if (!item.agent || item.agent === "workflow") continue;
			counts.set(item.agent, (counts.get(item.agent) ?? 0) + 1);
		}
		if (counts.size === 0) return "subagent";
		const parts: string[] = [];
		for (const [name, count] of counts) {
			parts.push(count > 1 ? `${name} ×${count}` : name);
		}
		return parts.join(", ");
	}

	function readSubagentTranscript(item: SubagentItem): string[] {
		if (!item.asyncDir) return ["No live transcript directory available for this run."];
		const idx = item.stepIndex ?? 0;
		for (const name of [`output-${idx}.log`, "output-0.log", `subagent-log-${item.runId}.md`]) {
			const p = join(item.asyncDir, name);
			if (existsSync(p)) {
				try {
					const raw = readFileSync(p, "utf8").trim();
					if (raw) return raw.split(/\r?\n/).slice(-120);
				} catch {}
			}
		}
		return [`${item.agent} is ${item.state} (${formatElapsed((item.endedAt ?? Date.now()) - item.startedAt)})…`];
	}

	function openSubagentInspectOverlay(item: SubagentItem) {
		if (!activeCtx || activeCtx.mode !== "tui") return;
		void activeCtx.ui.custom((tui, theme, _kb, done) => {
			let scrollOffset = 0;
			const timer = setInterval(() => tui.requestRender(), 400);
			timer.unref?.();
			return {
				handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, Key.enter)) {
						clearInterval(timer);
						done(undefined);
						return;
					}
					if (matchesKey(data, "up") || matchesKey(data, "k")) {
						scrollOffset = Math.min(100, scrollOffset + 3);
						tui.requestRender();
					} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
						scrollOffset = Math.max(0, scrollOffset - 3);
						tui.requestRender();
					}
				},
				render(width: number): string[] {
					const w = Math.max(24, width);
					const sep = theme.fg("dim", "│");
					const badge = agentModelBadge(item.agent, item.model);
					const elapsed = formatElapsed((item.endedAt ?? Date.now()) - item.startedAt);
					const tok = formatTok(item.tokens);
					const st = TERMINAL_STATES.has(item.state.toLowerCase())
						? theme.fg("success", item.state)
						: theme.fg("accent", `${SPINNER_FRAMES[spinnerIndex]} ${item.state}`);
					const headerLeft = ` ${theme.fg("text", item.agent)}${badge ? ` ${sep} ${theme.fg("dim", badge)}` : ""} ${sep} ${st}`;
					const headerRight = `${theme.fg("dim", [elapsed, tok, "↑↓ scroll · esc close"].filter(Boolean).join(" │ "))} `;
					const topLine = theme.fg("accent", "─".repeat(w));
					const headerLine = row(headerLeft, headerRight, w, 0.55);
					const dividerLine = theme.fg("dim", "─".repeat(w));
					const allLines = readSubagentTranscript(item);
					const windowSize = 18;
					const end = Math.max(1, allLines.length - scrollOffset);
					const start = Math.max(0, end - windowSize);
					const body = allLines.slice(start, end).map(l => truncateToWidth(`  ${theme.fg("muted", l)}`, w, "…"));
					return [topLine, headerLine, dividerLine, ...body, topLine];
				},
				invalidate() {},
				dispose() {
					clearInterval(timer);
				},
			};
		});
	}

	(globalThis as any).__piSubagentDrawerLines = (width: number, theme: any): string[] => {
		if (!drawerOpen) return [];
		const list = drawerCandidates();
		if (list.length === 0) return [];
		if (!list.some(i => i.key === selectedDrawerKey)) {
			selectedDrawerKey = list[0]!.key;
		}
		const sep = theme.fg("dim", "│");
		const lines: string[] = [];
		for (let i = 0; i < list.length; i++) {
			const item = list[i]!;
			const isLast = i === list.length - 1;
			const isSelected = item.key === selectedDrawerKey;
			const branch = theme.fg("dim", isLast ? " └─" : " ├─");
			const cursor = isSelected ? theme.fg("accent", "❯") : " ";
			const namePart = isSelected ? theme.fg("text", item.agent) : theme.fg("muted", item.agent);
			const badge = agentModelBadge(item.agent, item.model);
			const modelPart = badge ? theme.fg("dim", badge) : "";
			const st = item.state.toLowerCase();
			const statePart = !TERMINAL_STATES.has(st)
				? theme.fg("accent", "running")
				: st === "complete" || st === "completed"
					? theme.fg("success", "done")
					: theme.fg("error", st);
			const left = `${branch} ${cursor} ${[namePart, modelPart, statePart].filter(Boolean).join(` ${sep} `)}`;
			const elapsed = formatElapsed((item.endedAt ?? Date.now()) - item.startedAt);
			const tok = formatTok(item.tokens);
			const right = theme.fg("dim", [elapsed, tok].filter(Boolean).join(" │ "));
			lines.push(row(left, right, width, 0.4));
		}
		return lines;
	};

	function handleDrawerKey(data: string, editorEmpty: boolean): boolean {
		const list = drawerCandidates();
		if (list.length === 0) {
			drawerOpen = false;
			return false;
		}
		if (!drawerOpen) {
			if (!editorEmpty || !matchesKey(data, "down")) return false;
			drawerOpen = true;
			selectedDrawerKey = list[0]!.key;
			requestRender();
			return true;
		}
		const idx = Math.max(0, list.findIndex(i => i.key === selectedDrawerKey));
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			selectedDrawerKey = list[Math.min(list.length - 1, idx + 1)]!.key;
			requestRender();
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (idx <= 0) {
				drawerOpen = false;
				requestRender();
				return true;
			}
			selectedDrawerKey = list[idx - 1]!.key;
			requestRender();
			return true;
		}
		if (matchesKey(data, "escape")) {
			drawerOpen = false;
			requestRender();
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			const target = list[idx];
			drawerOpen = false;
			requestRender();
			if (target) openSubagentInspectOverlay(target);
			return true;
		}
		return false;
	}

	pi.events.on("pi-auto-review:audit", (raw: any) => {
		if (!raw || typeof raw !== "object") return;
		if (raw.type === "review_start" || raw.type === "review_attempt") {
			reviewingActive = true;
		} else if (raw.type === "review_complete") {
			reviewingActive = false;
		}
		syncTimer();
		if (activeCtx?.mode === "tui") requestRender();
	});

	pi.events.on("permissions:decision", () => {
		if (reviewingActive) {
			reviewingActive = false;
			syncTimer();
			if (activeCtx?.mode === "tui") requestRender();
		}
	});

	pi.events.on("subagent:async-started", (raw: any) => {
		if (!raw || typeof raw !== "object") return;
		const id = typeof raw.id === "string" ? raw.id : typeof raw.runId === "string" ? raw.runId : undefined;
		if (!id) return;
		const asyncDir = typeof raw.asyncDir === "string" ? raw.asyncDir : undefined;
		if (raw.mode === "workflow") return;
		const agents = Array.isArray(raw.agents)
			? raw.agents.filter((a: unknown): a is string => typeof a === "string" && Boolean(a))
			: typeof raw.agent === "string" && raw.agent
				? [raw.agent]
				: ["subagent"];
		agents.forEach((agent: string, index: number) => {
			const key = agents.length > 1 ? `${id}:${index}` : id;
			subagentItems.set(key, {
				key,
				runId: id,
				agent,
				state: "running",
				startedAt: Date.now(),
				asyncDir,
				stepIndex: index,
			});
		});
		syncTimer();
		if (activeCtx?.mode === "tui") requestRender();
	});

	pi.events.on("subagent:child-status", (raw: any) => {
		if (!raw || typeof raw !== "object" || typeof raw.runId !== "string" || typeof raw.childId !== "string") return;
		const slotKey = typeof raw.workflowKey === "string" && raw.workflowKey
			? `${raw.runId}:${raw.workflowKey}`
			: typeof raw.stepIndex === "number"
				? `${raw.runId}:step-${raw.stepIndex}`
				: `${raw.runId}:${raw.childId}`;
		const childRunId = typeof raw.childRunId === "string" && raw.childRunId ? raw.childRunId : undefined;
		if (raw.status === "started") {
			let prior: SubagentItem | undefined = subagentItems.get(slotKey);
			for (const [k, v] of subagentItems) {
				if (k === slotKey || (childRunId && (k === childRunId || v.runId === childRunId))) {
					prior ??= v;
					if (k !== slotKey) subagentItems.delete(k);
				}
			}
			const alreadyTerminal = prior ? TERMINAL_STATES.has(prior.state.toLowerCase()) : false;
			const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : prior?.agent ?? "subagent";
			const asyncDir = typeof raw.asyncDir === "string" ? raw.asyncDir : prior?.asyncDir;
			subagentItems.set(slotKey, {
				key: slotKey,
				runId: childRunId ?? slotKey,
				agent,
				state: alreadyTerminal && prior ? prior.state : "running",
				startedAt: prior?.startedAt ?? Date.now(),
				endedAt: alreadyTerminal ? prior?.endedAt : undefined,
				tokens: prior?.tokens,
				asyncDir,
				stepIndex: typeof raw.stepIndex === "number" ? raw.stepIndex : prior?.stepIndex ?? 0,
			});
		} else if (raw.status === "stopped") {
			for (const [k, v] of subagentItems) {
				if (k === slotKey || k === `${raw.runId}:${raw.childId}` || (childRunId && (k === childRunId || v.runId === childRunId))) {
					if (!TERMINAL_STATES.has(v.state.toLowerCase())) {
						v.state = "complete";
					}
					v.endedAt ??= Date.now();
				}
			}
			if (runningItems().length === 0) drawerOpen = false;
		}
		syncTimer();
		if (activeCtx?.mode === "tui") requestRender();
	});

	pi.events.on("subagent:async-complete", (raw: any) => {
		if (!raw || typeof raw !== "object") return;
		const id = typeof raw.runId === "string" ? raw.runId : typeof raw.id === "string" ? raw.id : undefined;
		if (!id) return;
		for (const [key, item] of subagentItems) {
			if (key === id || key.startsWith(`${id}:`) || item.runId === id) {
				if (!TERMINAL_STATES.has(item.state.toLowerCase())) {
					item.state = "complete";
				}
				item.endedAt ??= Date.now();
			}
		}
		if (runningItems().length === 0) drawerOpen = false;
		syncTimer();
		if (activeCtx?.mode === "tui") requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		currentModelId = ctx.model?.id ?? "no-model";
		subagentItems.clear();
		drawerOpen = false;
		reviewingActive = false;
		syncTimer();
		if (ctx.mode !== "tui") return;
		const origSetWidget = ctx.ui.setWidget.bind(ctx.ui);
		(ctx.ui as any).setWidget = (key: string, content: any, options?: any) => {
			if (key === "pi-auto-review") {
				reviewingActive = Boolean(content);
				syncTimer();
				requestRender();
				return origSetWidget(key, undefined, options);
			}
			if (key === "subagent-fleet-status") {
				return origSetWidget(key, undefined, options);
			}
			return origSetWidget(key, content, options);
		};
		ctx.ui.setStatus("compact-warning", undefined);
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map(frame => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 35,
		});
		ctx.ui.setEditorComponent((tui, theme, kb, options) => {
			requestRender = () => tui.requestRender();
			return new TopRightStatusEditor(
				tui,
				theme,
				kb,
				() => ({
					tokens: activeCtx?.getContextUsage()?.tokens ?? undefined,
					model: currentModelId || activeCtx?.model?.id || "no-model",
					thinking: pi.getThinkingLevel() ?? "",
					subagentLabel: currentSubagentLabel(),
					reviewingLabel: reviewingActive ? "Reviewing" : "",
					spinnerFrame: SPINNER_FRAMES[spinnerIndex] ?? SPINNER_FRAMES[0],
					fg: (color, text) => activeCtx?.ui?.theme ? activeCtx.ui.theme.fg(color as any, text) : text,
				}),
				handleDrawerKey,
				options,
			);
		});
	});

	pi.on("session_shutdown", () => {
		subagentItems.clear();
		drawerOpen = false;
		reviewingActive = false;
		syncTimer();
	});

	pi.on("model_select", (event, ctx) => {
		activeCtx = ctx;
		currentModelId = event.model?.id ?? "no-model";
		if (ctx.mode === "tui") requestRender();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		activeCtx = ctx;
		if (ctx.mode === "tui") requestRender();
	});

	for (const event of ["turn_end", "agent_end", "session_compact"] as const) {
		pi.on(event, (_event, ctx) => {
			activeCtx = ctx;
			if (ctx.mode === "tui") {
				ctx.ui.setStatus("compact-warning", undefined);
				requestRender();
			}
		});
	}

	pi.on("tool_result", (event) => {
		if (event.toolName !== "read" && event.toolName !== "bash") return;
		if (!Array.isArray(event.content)) return;
		let anyChanged = false;
		const content = event.content.map((block: any) => {
			if (!block || block.type !== "text" || typeof block.text !== "string") return block;
			const { text, changed } = sanitizeToolText(block.text);
			if (!changed) return block;
			anyChanged = true;
			return { ...block, text };
		});
		if (!anyChanged) return;
		const firstText = content.find((b: any) => b?.type === "text")?.text;
		return {
			content,
			...(typeof event.structuredContent === "string" && firstText !== undefined
				? { structuredContent: firstText }
				: {}),
		};
	});
}
