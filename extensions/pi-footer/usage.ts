import { createHash } from "node:crypto";
import { acceptSample, CACHE_MS, parseWeekUsage, type QuotaState, type WeekSample } from "./core.ts";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export interface ResolvedAuth {
	source?: string;
	auth: { apiKey?: string; headers?: Record<string, string | null | undefined> };
}
export interface AccountSample { account: string; sample: WeekSample }
export type UsageCode = "pending" | "ok" | "auth-missing" | "auth-non-oauth" | "auth-error" |
	"account-missing" | "http" | "network" | "timeout" | "payload-missing-weekly" | "internal";
export interface UsageDiagnostic { code: UsageCode; status?: number }
const SAFE_CODES = new Set<UsageCode>(["pending", "ok", "auth-missing", "auth-non-oauth", "auth-error",
	"account-missing", "http", "network", "timeout", "payload-missing-weekly", "internal"]);
export class UsageFailure extends Error {
	constructor(readonly code: UsageCode, readonly status?: number) {
		super(status === undefined ? code : `${code} ${status}`);
	}
}
export function safeDiagnostic(error: unknown, signal?: AbortSignal): UsageDiagnostic {
	if (signal?.aborted) return { code: "timeout" };
	if (error instanceof UsageFailure && SAFE_CODES.has(error.code)) return { code: error.code,
		...(error.code === "http" && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599
			? { status: error.status } : {}) };
	return { code: "internal" }; // Never retain arbitrary exception messages, causes, or response bodies.
}
export function supportedProvider(provider: string | undefined): provider is "openai" | "openai-codex" {
	return provider === "openai" || provider === "openai-codex";
}
export async function loadProviderUsage(provider: string | undefined,
	registry: { getProviderAuth(provider: string): Promise<ResolvedAuth | undefined> }, signal: AbortSignal,
	fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<AccountSample> {
	if (!supportedProvider(provider)) throw new UsageFailure("auth-missing");
	// Bind to exactly the selected provider. No legacy/account fallback and no API key substitution.
	return loadUsage(() => registry.getProviderAuth(provider), signal, fetcher, now);
}

/** Cancellation of our wait does not cancel Pi's locked OAuth refresh/persistence. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("cancelled"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
export async function loadUsage(resolveAuth: () => Promise<ResolvedAuth | undefined>, signal: AbortSignal,
	fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<AccountSample> {
	if (signal.aborted) throw new UsageFailure("timeout");
	let resolved: ResolvedAuth | undefined;
	try { resolved = await abortable(resolveAuth(), signal); }
	catch { throw new UsageFailure(signal.aborted ? "timeout" : "auth-error"); }
	if (!resolved) throw new UsageFailure("auth-missing");
	if (resolved.source !== "OAuth") throw new UsageFailure("auth-non-oauth");
	if (!resolved.auth?.apiKey) throw new UsageFailure("auth-missing");
	const token = resolved.auth.apiKey;
	let account = Object.entries(resolved.auth.headers ?? {}).find(([key]) => key.toLowerCase() === "chatgpt-account-id")?.[1];
	if (!account) {
		try {
			const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
			account = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		} catch { throw new UsageFailure("account-missing"); }
	}
	if (typeof account !== "string" || !account || /[\r\n]/.test(account)) throw new UsageFailure("account-missing");
	let response: Response;
	try {
		response = await fetcher(USAGE_URL, {
			method: "GET", redirect: "error", signal,
			headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
		});
	} catch { throw new UsageFailure(signal.aborted ? "timeout" : "network"); }
	// Never read/log an error response body: it can contain account/auth details.
	if (!response.ok) throw new UsageFailure("http", response.status);
	let sample: WeekSample | undefined;
	try { sample = parseWeekUsage(await response.json(), now()); }
	catch { throw new UsageFailure(signal.aborted ? "timeout" : "payload-missing-weekly"); }
	if (!sample) throw new UsageFailure("payload-missing-weekly");
	return { account: createHash("sha256").update(account).digest("hex"), sample };
}

export interface PollerOptions {
	sessionId: string;
	initial?: QuotaState;
	provider?: string;
	load(signal: AbortSignal): Promise<AccountSample>;
	persist(state: QuotaState): void;
	changed(): void;
	now?: () => number;
	timeoutMs?: number;
}
/** No I/O in render. The session heartbeat drives reset and bounded failure retries. */
export class UsagePoller {
	state: QuotaState | undefined;
	failed = false;
	diagnostic: UsageDiagnostic = { code: "pending" };
	private previous: QuotaState | undefined;
	private nextAt = 0;
	private failures = 0;
	private disposed = false;
	private controller: AbortController | undefined;
	private inFlight: Promise<void> | undefined;
	private now: () => number;
	constructor(private options: PollerOptions) {
		this.previous = options.initial;
		this.state = !options.provider || options.initial?.authProvider === options.provider ? options.initial : undefined;
		this.now = options.now ?? Date.now;
		if (this.state) this.diagnostic = { code: "ok" };
		if (this.state) this.nextAt = this.state.latest.fetchedAt + CACHE_MS;
	}
	request(): Promise<void> {
		// A newly reached reset invalidates the cache, but never defeats failure backoff.
		const resetDue = this.state && this.now() >= this.state.latest.resetAt &&
			this.state.latest.fetchedAt < this.state.latest.resetAt && !this.failed;
		if (this.disposed || (this.now() < this.nextAt && !resetDue)) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.refresh().finally(() => { this.inFlight = undefined; });
		return this.inFlight;
	}
	tick() {
		if (this.failed || (this.state && this.now() >= this.state.latest.resetAt)) void this.request();
	}
	private async refresh() {
		const controller = new AbortController();
		this.controller = controller;
		const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
		timer.unref?.();
		try {
			const result = await abortable(this.options.load(controller.signal), controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.state = acceptSample(this.state ?? this.previous, result.sample, this.options.sessionId, result.account);
			if (this.options.provider) this.state.authProvider = this.options.provider;
			this.previous = undefined;
			this.options.persist(this.state);
			this.diagnostic = { code: "ok" };
			this.failures = 0;
			this.failed = false;
			this.nextAt = this.now() + CACHE_MS;
		} catch (error) {
			if (this.disposed) return;
			this.diagnostic = safeDiagnostic(error, controller.signal);
			this.failed = true;
			this.failures++;
			this.nextAt = this.now() + Math.min(15 * 60_000, CACHE_MS * 2 ** Math.min(this.failures - 1, 4));
		} finally {
			clearTimeout(timer);
			if (this.controller === controller) this.controller = undefined;
			if (!this.disposed) this.options.changed();
		}
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.controller?.abort();
	}
}
