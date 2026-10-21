import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const COMPACT_THRESHOLD_TOKENS = 512_000;
export const MAX_LINE_CHARS = 2_000;
export const MAX_TOOL_TEXT_CHARS = 24_000;

const ICON_GOOGLE = "\uf1a0";
const ICON_OPENAI = "\uec81";
const ICON_CLAUDE = "\uec82";
const ICON_MODEL = "\uec19";
const ICON_THINKING = "\uf400";
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
	fg?: (color: string, text: string) => string;
}

class TopRightStatusEditor extends CustomEditor {
	constructor(
		tui: any,
		private readonly editorTheme: any,
		keybindings: any,
		private readonly getState: () => TopRightState,
		options?: any,
	) {
		super(tui, editorTheme, keybindings, { ...options, embedWorkingStatus: true });
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
		const { model, thinking, fg: stateFg } = this.getState();
		const fg = (color: string, text: string) => {
			if (typeof stateFg === "function") return stateFg(color, text);
			if (typeof this.editorTheme?.fg === "function") return this.editorTheme.fg(color, text);
			return text;
		};
		const leftBrand = this.borderColor("\u03c0 ");
		const leftBrandWidth = visibleWidth(leftBrand);
		const workingPart =
			indicator && typeof indicator.renderInBorder === "function"
				? String(indicator.renderInBorder(Math.max(12, Math.floor(width * 0.35)))).trim()
				: "";
		const rawModel = model || "no-model";
		const shortModel = formatShortModelName(rawModel);
		const icon = modelIcon(rawModel);
		const styledModel = fg("text", `${icon} ${shortModel}`);
		const styledThinking = thinking
			? fg(thinkingColorRole(thinking), `${ICON_THINKING} ${thinking}`)
			: "";
		const modelPart = [styledModel, styledThinking].filter(Boolean).join("  ");
		const rightContent = [workingPart, modelPart].filter(Boolean).join("  ");
		const rightBadge = ` ${rightContent} ${this.borderColor("─")}`;
		const rightBadgeWidth = visibleWidth(rightBadge);
		if (width <= leftBrandWidth + rightBadgeWidth + 4) return base;
		const middleWidth = Math.max(1, width - leftBrandWidth - rightBadgeWidth);
		return leftBrand + this.borderColor("─".repeat(middleWidth)) + rightBadge;
	}
}

export default function (pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | undefined;
	let currentModelId = "";
	let requestRender = () => {};

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		currentModelId = ctx.model?.id ?? "no-model";
		if (ctx.mode !== "tui") return;
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
					fg: (color, text) => activeCtx?.ui?.theme ? activeCtx.ui.theme.fg(color as any, text) : text,
				}),
				options,
			);
		});
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
