import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
}

interface SessionFileInfo {
	filePath: string;
	fileName: string;
	workspaceDir: string;
	workspaceName: string;
	sessionId: string;
	cwd: string;
	startedAt: string;
	mtimeMs: number;
	sizeBytes: number;
}

interface ParsedTurnLine {
	lineNumber: number;
	type: string;
	timestamp: string;
	role?: string;
	model?: string;
	text: string;
	toolCalls: Array<{ name: string; summary: string; rawArgs: Record<string, unknown> }>;
	toolResultSummary?: string;
	isReadOnlyToolTurn: boolean;
	readPaths: string[];
	compactionTokens?: number;
}

const MAX_CONSECUTIVE_READ_STREAK = 20;
const MAX_SAME_FILE_READ_STREAK = 5;
const MIN_FIRST_READ_LIMIT = 300;
const WIDENED_REPEAT_READ_LIMIT = 1600;

function getAgentRoot(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getSessionsRoot(): string {
	return join(getAgentRoot(), "sessions");
}

function normalizeSlash(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function readFirstLine(filePath: string): string {
	try {
		const raw = readFileSync(filePath, "utf8");
		const idx = raw.indexOf("\n");
		return (idx >= 0 ? raw.slice(0, idx) : raw).trim();
	} catch {
		return "";
	}
}

function parseSessionHeader(firstLine: string, fallbackFile: string, workspaceDir: string): SessionHeader {
	try {
		const parsed = JSON.parse(firstLine);
		if (parsed && typeof parsed === "object" && parsed.type === "session") {
			return {
				type: "session",
				version: parsed.version,
				id: typeof parsed.id === "string" ? parsed.id : fallbackFile,
				timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
				cwd: typeof parsed.cwd === "string" ? parsed.cwd : workspaceDir,
			};
		}
	} catch {
		// fall through
	}
	const idMatch = fallbackFile.match(/_([0-9a-f-]{8,})\.jsonl$/i);
	return {
		type: "session",
		id: idMatch?.[1] ?? fallbackFile.replace(/\.jsonl$/i, ""),
		timestamp: fallbackFile.slice(0, 24),
		cwd: workspaceDir,
	};
}

function discoverSessionFiles(workspaceFilter?: string, currentCwd?: string): SessionFileInfo[] {
	const root = getSessionsRoot();
	if (!existsSync(root)) return [];
	const filterRaw = (workspaceFilter ?? "").trim();
	const isAll = filterRaw.toLowerCase() === "all" || filterRaw === "*";
	const targetQuery = !filterRaw || filterRaw.toLowerCase() === "current"
		? normalizeSlash(currentCwd || process.cwd())
		: normalizeSlash(filterRaw);
	const targetLower = targetQuery.toLowerCase();
	const targetBase = basename(targetQuery).toLowerCase();

	const results: Array<SessionFileInfo & { matchScore: number }> = [];
	let dirs: string[] = [];
	try {
		dirs = readdirSync(root);
	} catch {
		return [];
	}

	for (const dirName of dirs) {
		if (dirName === "permission-forwarding") continue;
		const fullDir = join(root, dirName);
		let st;
		try {
			st = statSync(fullDir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;

		let files: string[] = [];
		try {
			files = readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const fileName of files) {
			const filePath = join(fullDir, fileName);
			let fst;
			try {
				fst = statSync(filePath);
			} catch {
				continue;
			}
			const firstLine = readFirstLine(filePath);
			const header = parseSessionHeader(firstLine, fileName, dirName);
			const cwdNorm = normalizeSlash(header.cwd);
			const cwdLower = cwdNorm.toLowerCase();
			const cwdBase = basename(cwdNorm).toLowerCase();
			const dirLower = dirName.toLowerCase();

			let matchScore = 0;
			if (isAll) {
				matchScore = 1;
			} else if (cwdLower === targetLower || dirLower === targetLower) {
				matchScore = 100;
			} else if (cwdBase === targetLower || cwdBase === targetBase && targetBase.length > 1 && !filterRaw.includes("/")) {
				matchScore = 80;
			} else if (cwdLower.includes(targetLower) || dirLower.includes(targetLower)) {
				matchScore = 50;
			}

			if (matchScore > 0) {
				results.push({
					filePath,
					fileName,
					workspaceDir: fullDir,
					workspaceName: cwdNorm || dirName,
					sessionId: header.id,
					cwd: header.cwd,
					startedAt: header.timestamp,
					mtimeMs: fst.mtimeMs,
					sizeBytes: fst.size,
					matchScore,
				});
			}
		}
	}

	if (results.length === 0) return [];
	const maxScore = Math.max(...results.map((r) => r.matchScore));
	const filtered = isAll ? results : results.filter((r) => r.matchScore === maxScore);
	filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return filtered;
}

function resolveTargetSessions(
	ctx: ExtensionContext,
	workspaceArg?: string,
	sessionArg?: string,
): { files: SessionFileInfo[]; error?: string } {
	const currentCwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const currentFile = ctx.sessionManager.getSessionFile?.();
	const currentId = ctx.sessionManager.getSessionId?.();
	const wsRaw = (workspaceArg ?? "").trim();
	const sessRaw = (sessionArg ?? "").trim();
	const isCurrentWorkspace = !wsRaw || wsRaw.toLowerCase() === "current";

	if (isCurrentWorkspace && (!sessRaw || sessRaw.toLowerCase() === "current") && currentFile && existsSync(currentFile)) {
		const fst = statSync(currentFile);
		const firstLine = readFirstLine(currentFile);
		const workspaceDir = dirnameSafe(currentFile);
		const header = parseSessionHeader(firstLine, basename(currentFile), basename(workspaceDir));
		return {
			files: [
				{
					filePath: currentFile,
					fileName: basename(currentFile),
					workspaceDir,
					workspaceName: normalizeSlash(header.cwd || currentCwd),
					sessionId: header.id || currentId || "current",
					cwd: header.cwd || currentCwd,
					startedAt: header.timestamp,
					mtimeMs: fst.mtimeMs,
					sizeBytes: fst.size,
				},
			],
		};
	}

	const candidates = discoverSessionFiles(wsRaw || "current", currentCwd);
	if (candidates.length === 0) {
		return {
			files: [],
			error: `未找到匹配工作区 ${JSON.stringify(wsRaw || currentCwd)} 的会话记录。可用 action: "list", workspace: "all" 查看全部工作区。`,
		};
	}

	if (!sessRaw || sessRaw.toLowerCase() === "latest" || sessRaw.toLowerCase() === "current") {
		if (sessRaw.toLowerCase() === "current" && currentFile) {
			const matchCurrent = candidates.find((c) => normalizeSlash(c.filePath) === normalizeSlash(currentFile));
			if (matchCurrent) return { files: [matchCurrent] };
		}
		return { files: [candidates[0]!] };
	}

	if (sessRaw.toLowerCase() === "all" || sessRaw === "*") {
		return { files: candidates };
	}

	const needle = sessRaw.toLowerCase();
	const matched = candidates.filter(
		(c) =>
			c.sessionId.toLowerCase().startsWith(needle) ||
			c.sessionId.toLowerCase().includes(needle) ||
			c.fileName.toLowerCase().includes(needle),
	);
	if (matched.length === 0) {
		return {
			files: [],
			error: `在工作区 ${candidates[0]?.workspaceName} 中未找到匹配 session=${JSON.stringify(sessRaw)} 的记录。`,
		};
	}
	return { files: matched };
}

function dirnameSafe(p: string): string {
	const norm = normalizeSlash(p);
	const idx = norm.lastIndexOf("/");
	return idx >= 0 ? norm.slice(0, idx) : ".";
}

function compactText(text: string, maxChars: number): string {
	const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars)}… [truncated ${cleaned.length - maxChars} chars]`;
}

function oneLine(text: string, maxChars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= maxChars) return flat;
	return `${flat.slice(0, maxChars)}…`;
}

function summarizeToolCall(name: string, args: Record<string, unknown>, detailed = false): string {
	if (name === "read") {
		const p = typeof args.path === "string" ? (detailed ? args.path : basename(args.path)) : "";
		const range =
			args.offset != null || args.limit != null
				? `:${args.offset ?? 1}+${args.limit ?? "all"}`
				: "";
		return `read(${p}${range})`;
	}
	if (name === "edit" || name === "write") {
		const p = typeof args.path === "string" ? (detailed ? args.path : basename(args.path)) : "";
		if (!detailed) return `${name}(${p})`;
		if (name === "edit" && Array.isArray(args.edits)) {
			return `edit(${p}, ${args.edits.length} block(s))`;
		}
		return `${name}(${p})`;
	}
	if (name === "bash") {
		const cmd = typeof args.command === "string" ? oneLine(args.command, detailed ? 220 : 80) : "";
		return `bash(${JSON.stringify(cmd)})`;
	}
	if (name === "subagent") {
		const agent = typeof args.agent === "string" ? args.agent : args.workflow ? `workflow:${args.workflow}` : "call";
		const model = typeof args.model === "string" ? ` [${args.model.split("/").pop()}]` : "";
		const task = typeof args.task === "string" ? `: ${oneLine(args.task, detailed ? 240 : 80)}` : "";
		return `subagent(${agent}${model}${task})`;
	}
	return `${name}(${oneLine(JSON.stringify(args), detailed ? 160 : 60)})`;
}

function parseJsonlLines(filePath: string): ParsedTurnLine[] {
	const raw = readFileSync(filePath, "utf8");
	const rawLines = raw.split("\n");
	const out: ParsedTurnLine[] = [];

	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i]!.trim();
		if (!line) continue;
		const lineNumber = i + 1;
		let obj: any;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (!obj || typeof obj !== "object") continue;

		if (obj.type === "compaction") {
			out.push({
				lineNumber,
				type: "compaction",
				timestamp: obj.timestamp || "",
				text: typeof obj.summary === "string" ? obj.summary : "",
				toolCalls: [],
				isReadOnlyToolTurn: false,
				readPaths: [],
				compactionTokens: typeof obj.tokensBefore === "number" ? obj.tokensBefore : undefined,
			});
			continue;
		}

		if (obj.type === "custom" && typeof obj.customType === "string") {
			if (obj.customType.includes("quota")) continue;
			if (obj.customType.includes("subagent")) {
				out.push({
					lineNumber,
					type: "custom",
					timestamp: obj.timestamp || "",
					text: `[${obj.customType}] ${oneLine(JSON.stringify(obj.data ?? {}), 240)}`,
					toolCalls: [],
					isReadOnlyToolTurn: false,
					readPaths: [],
				});
			}
			continue;
		}

		if (obj.type !== "message" || !obj.message || typeof obj.message !== "object") continue;
		const m = obj.message;
		const role = typeof m.role === "string" ? m.role : "unknown";
		const content = Array.isArray(m.content) ? m.content : [];

		if (role === "user") {
			const text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			out.push({
				lineNumber,
				type: "message",
				timestamp: obj.timestamp || "",
				role: "user",
				text,
				toolCalls: [],
				isReadOnlyToolTurn: false,
				readPaths: [],
			});
		} else if (role === "assistant") {
			const text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			const rawTools = content.filter((c: any) => c?.type === "toolCall" && typeof c.name === "string");
			const toolCalls = rawTools.map((t: any) => ({
				name: t.name as string,
				summary: summarizeToolCall(t.name, t.arguments ?? {}, false),
				rawArgs: (t.arguments ?? {}) as Record<string, unknown>,
			}));
			const isReadOnlyToolTurn =
				!text &&
				toolCalls.length > 0 &&
				toolCalls.every((t) => t.name === "read" || t.name === "grep" || t.name === "find" || t.name === "ls");
			const readPaths = toolCalls
				.filter((t) => t.name === "read" && typeof t.rawArgs.path === "string")
				.map((t) => basename(String(t.rawArgs.path)));
			out.push({
				lineNumber,
				type: "message",
				timestamp: obj.timestamp || "",
				role: "assistant",
				model: typeof m.model === "string" ? m.model : undefined,
				text,
				toolCalls,
				isReadOnlyToolTurn,
				readPaths,
			});
		} else if (role === "toolResult") {
			const toolName = typeof m.toolName === "string" ? m.toolName : "tool";
			const text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
			out.push({
				lineNumber,
				type: "message",
				timestamp: obj.timestamp || "",
				role: "toolResult",
				model: toolName,
				text,
				toolCalls: [],
				toolResultSummary: `[${toolName}${m.isError ? " ERROR" : ""}] ${oneLine(text, 220)}`,
				isReadOnlyToolTurn: toolName === "read",
				readPaths: [],
			});
		}
	}
	return out;
}

function handleList(ctx: ExtensionContext, workspaceArg?: string, limit = 10): string {
	const currentCwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	const files = discoverSessionFiles(workspaceArg || "all", currentCwd);
	if (files.length === 0) {
		return `未找到匹配 workspace=${JSON.stringify(workspaceArg || "all")} 的会话。`;
	}

	const slice = files.slice(0, Math.max(1, Math.min(50, limit)));
	const rows: string[] = [`找到 ${files.length} 个会话（显示最近 ${slice.length} 个）：\n`];

	for (const info of slice) {
		const parsed = parseJsonlLines(info.filePath);
		const userTurns = parsed.filter((p) => p.role === "user" && !p.text.startsWith("Inspect subagent updates above."));
		const compactions = parsed.filter((p) => p.type === "compaction").length;
		const subagentCalls = parsed.reduce(
			(acc, p) => acc + p.toolCalls.filter((t) => t.name === "subagent").length,
			0,
		);
		const lastLine = parsed.at(-1);
		const sizeMb = (info.sizeBytes / (1024 * 1024)).toFixed(1);
		const firstUsers = userTurns.slice(0, 2).map((u) => `  - [L${u.lineNumber}] ${oneLine(u.text, 120)}`);
		const lastUsers = userTurns
			.slice(-3)
			.filter((u) => !firstUsers.some((f) => f.includes(`[L${u.lineNumber}]`)))
			.map((u) => `  - [L${u.lineNumber}] ${oneLine(u.text, 120)}`);

		rows.push(
			`### Session \`${info.sessionId.slice(0, 8)}\` (${info.workspaceName})`,
			`- 文件: \`${info.fileName}\` (${sizeMb} MB, 最后行号 L${lastLine?.lineNumber ?? 1})`,
			`- 时间: ${info.startedAt || "?"} -> ${lastLine?.timestamp || new Date(info.mtimeMs).toISOString()}`,
			`- 统计: 用户消息 ${userTurns.length} 轮, Compaction ${compactions} 次, Subagent 调用 ${subagentCalls} 次`,
			...(firstUsers.length ? ["- 开场用户消息:", ...firstUsers] : []),
			...(lastUsers.length ? ["- 最近用户消息:", ...lastUsers] : []),
			"",
		);
	}
	return rows.join("\n");
}

function handleOutline(
	info: SessionFileInfo,
	fromLine?: number,
	toLine?: number,
	lastTurns?: number,
	limit = 120,
): string {
	const parsed = parseJsonlLines(info.filePath);
	let filtered = parsed.filter((p) => p.role !== "toolResult");

	if (fromLine !== undefined || toLine !== undefined) {
		const start = fromLine ?? 1;
		const end = toLine ?? Number.MAX_SAFE_INTEGER;
		filtered = filtered.filter((p) => p.lineNumber >= start && p.lineNumber <= end);
	} else if (lastTurns !== undefined && lastTurns > 0) {
		const userIndices = filtered
			.map((p, idx) => (p.role === "user" ? idx : -1))
			.filter((idx) => idx >= 0);
		const startIdx = userIndices.length > lastTurns ? userIndices[userIndices.length - lastTurns]! : 0;
		filtered = filtered.slice(startIdx);
	}

	const lines: string[] = [
		`## Session Outline: \`${info.sessionId}\` (${info.workspaceName})`,
		`文件: \`${info.fileName}\` | 范围: ${fromLine ?? 1}..${toLine ?? "end"}\n`,
	];

	let i = 0;
	while (i < filtered.length) {
		const item = filtered[i]!;
		if (item.isReadOnlyToolTurn) {
			let j = i;
			let totalReads = 0;
			const fileCounts = new Map<string, number>();
			while (j < filtered.length && filtered[j]!.isReadOnlyToolTurn) {
				totalReads += filtered[j]!.toolCalls.length;
				for (const rp of filtered[j]!.readPaths) {
					fileCounts.set(rp, (fileCounts.get(rp) ?? 0) + 1);
				}
				j++;
			}
			const startL = item.lineNumber;
			const endL = filtered[j - 1]!.lineNumber;
			const topFiles = [...fileCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6)
				.map(([f, c]) => (c > 1 ? `${f}(x${c})` : f))
				.join(", ");
			if (j - i >= 3) {
				lines.push(`[L${startL}..L${endL}] ASST (连续只读 ${totalReads} 次): ${topFiles}`);
			} else {
				for (let k = i; k < j; k++) {
					const fk = filtered[k]!;
					lines.push(`[L${fk.lineNumber}] ASST: TOOLS: ${fk.toolCalls.map((t) => t.summary).join(", ")}`);
				}
			}
			i = j;
			continue;
		}

		if (item.type === "compaction") {
			lines.push(
				`[L${item.lineNumber}] === COMPACTION (${item.compactionTokens ?? "?"} tokens) === ${oneLine(item.text, 160)}`,
			);
		} else if (item.type === "custom") {
			lines.push(`[L${item.lineNumber}] EVENT ${item.text}`);
		} else if (item.role === "user") {
			const isWake = item.text.startsWith("Inspect subagent updates above.");
			lines.push(
				`[L${item.lineNumber}] USER (${item.timestamp.slice(11, 19)}): ${isWake ? "[Subagent Wake Notification]" : oneLine(item.text, 240)}`,
			);
		} else if (item.role === "assistant") {
			const nonReadTools = item.toolCalls.filter((t) => t.name !== "read");
			const readCount = item.toolCalls.length - nonReadTools.length;
			const toolParts = [
				...nonReadTools.map((t) => t.summary),
				...(readCount > 0 ? [`read(x${readCount})`] : []),
			];
			const textPart = item.text ? oneLine(item.text, 200) : "";
			const toolStr = toolParts.length ? ` [TOOLS: ${toolParts.join(", ")}]` : "";
			if (textPart || toolStr) {
				lines.push(`[L${item.lineNumber}] ASST: ${textPart}${toolStr}`);
			}
		}
		i++;
	}

	if (lines.length > limit + 2) {
		const headCount = Math.floor(limit * 0.35);
		const tailCount = limit - headCount;
		const body = lines.slice(2);
		const omitted = body.length - headCount - tailCount;
		return [
			...lines.slice(0, 2),
			...body.slice(0, headCount),
			`\n... [中间省略 ${omitted} 行，可传 fromLine / toLine 分段查看] ...\n`,
			...body.slice(body.length - tailCount),
		].join("\n");
	}
	return lines.join("\n");
}

function handleSearch(
	files: SessionFileInfo[],
	query: string,
	includeToolResults = false,
	limit = 30,
): string {
	let matcher: (text: string) => boolean;
	const regexMatch = query.match(/^\/(.+)\/([gimsuy]*)$/);
	if (regexMatch) {
		try {
			const re = new RegExp(regexMatch[1]!, regexMatch[2] || "i");
			matcher = (t) => re.test(t);
		} catch (e) {
			return `无效的正则表达式 ${query}: ${e instanceof Error ? e.message : String(e)}`;
		}
	} else {
		const needle = query.toLowerCase();
		matcher = (t) => t.toLowerCase().includes(needle);
	}

	const hits: string[] = [];
	for (const info of files) {
		const parsed = parseJsonlLines(info.filePath);
		for (const item of parsed) {
			if (item.role === "toolResult" && !includeToolResults) continue;
			const toolSummary = item.toolCalls.map((t) => `${t.summary} ${JSON.stringify(t.rawArgs)}`).join(" ");
			const combined = `${item.text}\n${toolSummary}`;
			if (!matcher(combined)) continue;

			const roleTag =
				item.type === "compaction"
					? "COMPACTION"
					: item.role === "user"
						? "USER"
						: item.role === "assistant"
							? "ASST"
							: `TOOL(${item.model})`;
			const snippet = item.text
				? oneLine(item.text, 240)
				: item.toolCalls.map((t) => t.summary).join(", ");
			hits.push(
				`- [\`${info.sessionId.slice(0, 8)}\` L${item.lineNumber}] **${roleTag}** (${item.timestamp.slice(0, 19)}): ${snippet}`,
			);
			if (hits.length >= limit) break;
		}
		if (hits.length >= limit) break;
	}

	if (hits.length === 0) {
		return `未找到匹配 ${JSON.stringify(query)} 的记录（检索了 ${files.length} 个会话）。`;
	}
	return `搜索 ${JSON.stringify(query)} 命中 ${hits.length} 条记录：\n\n${hits.join("\n")}`;
}

function handleRead(
	info: SessionFileInfo,
	options: {
		fromLine?: number;
		toLine?: number;
		aroundLine?: number;
		lastTurns?: number;
		includeToolResults?: boolean;
	},
): string {
	const parsed = parseJsonlLines(info.filePath);
	let selected: ParsedTurnLine[] = [];

	if (options.aroundLine !== undefined) {
		const span = 20;
		const start = Math.max(1, options.aroundLine - span);
		const end = options.aroundLine + span;
		selected = parsed.filter((p) => p.lineNumber >= start && p.lineNumber <= end);
	} else if (options.fromLine !== undefined || options.toLine !== undefined) {
		const start = options.fromLine ?? 1;
		const end = options.toLine ?? (options.fromLine ? options.fromLine + 60 : Number.MAX_SAFE_INTEGER);
		selected = parsed.filter((p) => p.lineNumber >= start && p.lineNumber <= end);
	} else {
		const turns = options.lastTurns ?? 8;
		const userIndices = parsed
			.map((p, idx) => (p.role === "user" && !p.text.startsWith("Inspect subagent updates above.") ? idx : -1))
			.filter((idx) => idx >= 0);
		const startIdx = userIndices.length > turns ? userIndices[userIndices.length - turns]! : 0;
		selected = parsed.slice(startIdx);
	}

	const out: string[] = [
		`## Session Read: \`${info.sessionId}\` (${info.workspaceName})`,
		`文件: \`${info.fileName}\` | 命中节点数: ${selected.length}\n`,
	];

	let i = 0;
	while (i < selected.length) {
		const item = selected[i]!;
		if (!options.includeToolResults && item.isReadOnlyToolTurn) {
			let j = i;
			const files: string[] = [];
			while (j < selected.length && selected[j]!.isReadOnlyToolTurn) {
				files.push(...selected[j]!.readPaths);
				j++;
			}
			if (j - i >= 4) {
				const uniq = [...new Set(files)].slice(0, 8).join(", ");
				out.push(`[L${item.lineNumber}..L${selected[j - 1]!.lineNumber}] *(折叠连续 ${j - i} 条只读步骤: ${uniq})*\n`);
				i = j;
				continue;
			}
		}

		if (item.type === "compaction") {
			out.push(
				`### [L${item.lineNumber}] COMPACTION (${item.compactionTokens ?? "?"} tokens, ${item.timestamp})`,
				compactText(item.text, 2000),
				"",
			);
		} else if (item.role === "user") {
			out.push(`### [L${item.lineNumber}] USER (${item.timestamp})`, compactText(item.text, 2500), "");
		} else if (item.role === "assistant") {
			const header = `### [L${item.lineNumber}] ASSISTANT (${item.model ?? ""})`;
			const parts: string[] = [header];
			if (item.text) parts.push(compactText(item.text, 3000));
			if (item.toolCalls.length) {
				parts.push(
					"Tools:\n" +
						item.toolCalls
							.map((t) => `- ${summarizeToolCall(t.name, t.rawArgs, true)}`)
							.join("\n"),
				);
			}
			parts.push("");
			out.push(...parts);
		} else if (item.role === "toolResult") {
			if (options.includeToolResults) {
				out.push(
					`#### [L${item.lineNumber}] TOOL RESULT (${item.model})`,
					compactText(item.text, 1500),
					"",
				);
			} else if (item.model !== "read") {
				out.push(`- [L${item.lineNumber}] ${item.toolResultSummary}`);
			}
		}
		i++;
	}

	return out.join("\n");
}

function handleSubagent(info: SessionFileInfo, subagentRunId?: string): string {
	const artifactsDir = join(info.workspaceDir, "subagent-artifacts");
	if (!existsSync(artifactsDir)) {
		return `工作区 ${info.workspaceName} 下没有 subagent-artifacts 目录。`;
	}

	const files = readdirSync(artifactsDir);
	const metaFiles = files.filter((f) => f.endsWith("_meta.json"));
	if (metaFiles.length === 0) {
		return `工作区 ${info.workspaceName} 的 subagent-artifacts 中没有任何 *_meta.json 记录。`;
	}

	const needle = (subagentRunId ?? "").trim().toLowerCase();
	const matchedMetas = needle
		? metaFiles.filter((f) => f.toLowerCase().startsWith(needle) || f.toLowerCase().includes(needle))
		: metaFiles
				.map((f) => ({ f, mtime: statSync(join(artifactsDir, f)).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime)
				.map((x) => x.f);

	if (matchedMetas.length === 0) {
		return `未找到匹配 subagentRunId=${JSON.stringify(subagentRunId)} 的子代理记录。`;
	}

	if (!needle) {
		const rows: string[] = [`## 工作区 ${info.workspaceName} 最近的子代理运行记录：\n`];
		for (const mf of matchedMetas.slice(0, 15)) {
			try {
				const meta = JSON.parse(readFileSync(join(artifactsDir, mf), "utf8"));
				const changed = meta.acceptance?.childReport?.changedFiles ?? [];
				rows.push(
					`- **\`${meta.runId}\`** | agent: \`${meta.agent}\` | model: \`${meta.model}\` | exit: \`${meta.exitCode}\` | turns: ${meta.usage?.turns ?? "?"} | changedFiles: ${changed.length}`,
				);
			} catch {
				// ignore malformed
			}
		}
		rows.push("\n可传入 `subagentRunId` 查看某次运行的具体产出、改动文件与验证命令。");
		return rows.join("\n");
	}

	const targetMetaFile = matchedMetas[0]!;
	const meta = JSON.parse(readFileSync(join(artifactsDir, targetMetaFile), "utf8"));
	const prefix = targetMetaFile.replace(/_meta\.json$/, "");
	const outputFile = join(artifactsDir, `${prefix}_output.md`);
	const outputText = existsSync(outputFile) ? readFileSync(outputFile, "utf8").trim() : "";
	const report = meta.acceptance?.childReport ?? {};

	const lines: string[] = [
		`## Subagent Run \`${meta.runId}\` (${meta.agent} / ${meta.model})`,
		`- 父会话: \`${meta.parentSessionId}\` | ExitCode: \`${meta.exitCode}\` | Turns: ${meta.usage?.turns ?? "?"}`,
		...(Array.isArray(report.changedFiles) && report.changedFiles.length
			? [`- 修改文件 (${report.changedFiles.length}):\n` + report.changedFiles.map((f: string) => `  - \`${f}\``).join("\n")]
			: []),
		...(Array.isArray(report.commandsRun) && report.commandsRun.length
			? [
					`- 执行命令:\n` +
						report.commandsRun
							.map((c: any) => `  - [${c.result}] \`${oneLine(String(c.command ?? ""), 120)}\` — ${c.summary ?? ""}`)
							.join("\n"),
				]
			: []),
		...(Array.isArray(report.residualRisks) && report.residualRisks.length
			? [`- 剩余风险:\n` + report.residualRisks.map((r: string) => `  - ${r}`).join("\n")]
			: []),
		"",
		"### 子代理输出 (output.md)",
		outputText ? compactText(outputText, 4000) : "*(无 output.md 内容)*",
	];
	return lines.join("\n");
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

export default function registerSessionHistoryExtension(pi: ExtensionAPI) {
	let consecutiveReads = 0;
	const fileReadCounts = new Map<string, number>();

	function resetReadStreak() {
		consecutiveReads = 0;
		fileReadCounts.clear();
	}

	pi.on("session_start", () => resetReadStreak());
	pi.on("agent_start", () => resetReadStreak());
	pi.on("session_compact", () => resetReadStreak());

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "subagent") {
			const subInput = event.input as Record<string, unknown> | undefined;
			if (subInput && typeof subInput.action === "string") {
				const act = subInput.action.trim().toLowerCase();
				if (act === "cancel" || act === "kill" || act === "abort") {
					subInput.action = "stop";
				}
			}
		}
		if (event.toolName !== "read") {
			resetReadStreak();
			return;
		}
		const input = event.input as Record<string, unknown> | undefined;
		if (!input || typeof input !== "object") return;
		const rawPath = typeof input.path === "string" ? input.path : "";
		if (!rawPath || IMAGE_EXT_RE.test(rawPath)) return;

		const resolved = normalizeSlash(resolve(ctx.cwd, rawPath)).toLowerCase();
		const prevCount = fileReadCounts.get(resolved) ?? 0;
		const nextCount = prevCount + 1;
		fileReadCounts.set(resolved, nextCount);
		consecutiveReads += 1;

		if (nextCount >= MAX_SAME_FILE_READ_STREAK || consecutiveReads >= MAX_CONSECUTIVE_READ_STREAK) {
			return {
				block: true,
				reason: `已连续调用 read 达上限（当前连续只读 ${consecutiveReads} 次，文件 ${basename(rawPath)} 已连续读取 ${nextCount} 次）。请立即停止小窗口翻页式读取：1）我们已经自动为你放宽过单次读取行数，若已掌握上下文请直接执行 edit/write 或向用户汇报；2）若需跨多个文件定位符号或梳理模块，请使用 bash 运行 rg -n 或直接派发 scout 子代理；3）若因 compaction 遗忘了前文结论，请调用 session_history 工具回读。`,
			};
		}

		const limit = typeof input.limit === "number" ? input.limit : undefined;
		if (prevCount >= 1 && limit !== undefined && limit < WIDENED_REPEAT_READ_LIMIT) {
			input.limit = WIDENED_REPEAT_READ_LIMIT;
		} else if (prevCount === 0 && limit !== undefined && limit > 0 && limit < MIN_FIRST_READ_LIMIT) {
			input.limit = MIN_FIRST_READ_LIMIT;
		}
	});

	pi.registerTool({
		name: "session_history",
		label: "Session History",
		description:
			"检索和回读当前会话（含 Compaction 前的完整原始对话）或任意工作区（如 piko、animeko 等）的历史 Pi 会话与子代理记录。支持 list（列出工作区会话）、outline（生成会话全景时间线骨架并折叠重复 read）、search（关键词或 /regex/ 搜索）、read（按行号范围或最近 N 轮精读用户原话与改动）和 subagent（查看子代理产出与改动清单）。",
		parameters: Type.Object(
			{
				action: Type.String({
					enum: ["list", "outline", "search", "read", "subagent"],
					description: "操作类型：list | outline | search | read | subagent",
				}),
				workspace: Type.Optional(
					Type.String({
						description: "目标工作区：默认当前 cwd；可传项目名（如 'piko'）、路径（如 'C:/Codes/piko'）或 'all'",
					}),
				),
				session: Type.Optional(
					Type.String({
						description: "目标会话：'current'（当前会话）、'latest'（该工作区最新会话）、'all'（跨会话检索），或 sessionId 前缀",
					}),
				),
				query: Type.Optional(
					Type.String({
						description: "search 模式的搜索关键词或正则表达式（如 '/gallery|瀑布流/i'）",
					}),
				),
				fromLine: Type.Optional(
					Type.Integer({
						minimum: 1,
						description: "read / outline 模式的起始行号（1-indexed，对应 [Lxxx] 标记）",
					}),
				),
				toLine: Type.Optional(
					Type.Integer({
						minimum: 1,
						description: "read / outline 模式的结束行号（1-indexed）",
					}),
				),
				aroundLine: Type.Optional(
					Type.Integer({
						minimum: 1,
						description: "read 模式以该行号为中心读取上下文（前后各 20 条记录）",
					}),
				),
				lastTurns: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 100,
						description: "read / outline 模式仅读取最近 N 轮用户对话",
					}),
				),
				includeToolResults: Type.Optional(
					Type.Boolean({
						description: "是否在 search / read 中包含原始工具返回输出（默认折叠 read 源码回显）",
					}),
				),
				subagentRunId: Type.Optional(
					Type.String({
						description: "subagent 模式下要读取的子代理 runId 或前缀（留空则列出最近的子代理运行）",
					}),
				),
				limit: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 300,
						description: "返回结果的最大行数或条数",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = String(params.action || "outline");
			if (action === "list") {
				const text = handleList(ctx, params.workspace, params.limit ?? 10);
				return { content: [{ type: "text", text }], details: {} };
			}

			const resolved = resolveTargetSessions(
				ctx,
				params.workspace,
				action === "search" && !params.session ? "latest" : params.session,
			);
			if (resolved.error || resolved.files.length === 0) {
				return {
					content: [{ type: "text", text: resolved.error ?? "未找到匹配的会话记录。" }],
					isError: true,
					details: {},
				};
			}

			if (action === "search") {
				const query = String(params.query ?? "").trim();
				if (!query) {
					return {
						content: [{ type: "text", text: "search 模式需要提供非空的 query 参数。" }],
						isError: true,
						details: {},
					};
				}
				const text = handleSearch(
					resolved.files,
					query,
					params.includeToolResults === true,
					params.limit ?? 30,
				);
				return { content: [{ type: "text", text }], details: {} };
			}

			const target = resolved.files[0]!;
			if (action === "outline") {
				const text = handleOutline(
					target,
					params.fromLine,
					params.toLine,
					params.lastTurns,
					params.limit ?? 120,
				);
				return { content: [{ type: "text", text }], details: {} };
			}

			if (action === "read") {
				const text = handleRead(target, {
					fromLine: params.fromLine,
					toLine: params.toLine,
					aroundLine: params.aroundLine,
					lastTurns: params.lastTurns,
					includeToolResults: params.includeToolResults === true,
				});
				return { content: [{ type: "text", text }], details: {} };
			}

			if (action === "subagent") {
				const text = handleSubagent(target, params.subagentRunId);
				return { content: [{ type: "text", text }], details: {} };
			}

			return {
				content: [{ type: "text", text: `未知的 action: ${action}` }],
				isError: true,
				details: {},
			};
		},
	});
}
