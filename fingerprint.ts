/**
 * Cowork / Claude Code wire-fingerprint constants and helpers.
 *
 * Ported from omp (@oh-my-pi/pi-ai) `src/providers/claude-code-fingerprint.ts`
 * and the header/billing sections of `src/providers/anthropic.ts`.
 *
 * WHY A PORT AND NOT AN IMPORT:
 * omp ships raw TypeScript under `node_modules` and targets bun. Node refuses
 * to strip types for files under node_modules:
 *   "Stripping types is currently unsupported for files under node_modules"
 * so `import("@oh-my-pi/pi-ai")` from a pi extension is impossible. Everything
 * omp needs from bun (`Bun.hash.xxHash64`) is reimplemented here in pure JS.
 */

import nodeCrypto from "node:crypto";

// ---------------------------------------------------------------------------
// Version / identity constants (omp: claude-code-fingerprint.ts)
// ---------------------------------------------------------------------------

/** Claude runtime version bundled by the current Cowork desktop release. */
export const claudeCodeVersion = "2.1.220";

/** User-Agent emitted by Cowork's `claude-desktop` inference entrypoint. */
export const coworkUserAgent = `claude-cli/${claudeCodeVersion} (external, claude-desktop)`;

/** Prefix used to isolate custom Anthropic OAuth tools from built-in tools. */
export const claudeToolPrefix = "_";

/** Identity block prepended by Cowork's Claude runtime. */
export const claudeCodeSystemInstruction =
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** Cowork's per-request output-token ceiling. */
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;

// ---------------------------------------------------------------------------
// Beta profiles (omp: anthropic.ts lines ~157-206)
// ---------------------------------------------------------------------------

const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
const contextManagementBeta = "context-management-2025-06-27";
const structuredOutputsBeta = "structured-outputs-2025-12-15";
const thinkingTokenCountBeta = "thinking-token-count-2026-05-13";
const fallbackCreditBeta = "fallback-credit-2026-06-01";
const effortBeta = "effort-2025-11-24";

const coworkUtilityBetaDefaults = [
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	structuredOutputsBeta,
] as const;

const coworkAgentBetaDefaults = [
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	thinkingTokenCountBeta,
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	midConversationSystemBeta,
	"advanced-tool-use-2025-11-20",
] as const;

/**
 * NOTE (from omp): `context-1m-2025-08-07` is intentionally never advertised.
 * OAuth subscription credentials have no long-context credit balance, so
 * Anthropic hard-429s ("Usage credits are required for long context requests")
 * on any beta-gated 1M model regardless of prompt size.
 */
export function buildCoworkBetas(
	agentRequest: boolean,
	thinkingRequest: boolean,
	disableStrictTools = false,
): readonly string[] {
	if (!agentRequest && !disableStrictTools) return coworkUtilityBetaDefaults;
	const betas: string[] = [];
	for (const beta of agentRequest ? coworkAgentBetaDefaults : coworkUtilityBetaDefaults) {
		if (disableStrictTools && beta === structuredOutputsBeta) continue;
		betas.push(beta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	betas.push(fallbackCreditBeta);
	return betas;
}

export function buildBetaHeader(
	baseBetas: readonly string[],
	extraBetas: readonly string[],
): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const beta of [...baseBetas, ...extraBetas]) {
		const trimmed = beta.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out.join(",");
}

// ---------------------------------------------------------------------------
// Stainless / Cowork static headers (omp: anthropic.ts lines ~505-533)
// ---------------------------------------------------------------------------

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

/**
 * Static headers emitted by Cowork's Linux Claude runtime.
 *
 * DO NOT "portability-fix" these. `X-Stainless-OS` and `X-Stainless-Runtime-Version`
 * are pinned fingerprint values copied from omp 17.4.2 — they deliberately do NOT
 * describe the host running this code, and reading them from `process` would change
 * what goes out on the wire. Only `X-Stainless-Arch` is host-derived, which is what
 * omp does too.
 */
export const coworkHeaders: Record<string, string> = {
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-Lang": "js",
	"X-Stainless-OS": "Linux",
	"X-Stainless-Package-Version": "0.94.0",
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": "v26.3.0",
	"X-Stainless-Timeout": "600",
};

// ---------------------------------------------------------------------------
// Billing header + cch attestation (omp: anthropic.ts lines ~558-640)
// ---------------------------------------------------------------------------

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_PLACEHOLDER_STR = "cch=00000";
const CCH_SEED = 0x4d659218e32a3268n;
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
const BILLING_SYSTEM_MARKER = cchEncoder.encode(
	`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`,
);
const CCH_BILLING_SEARCH_WINDOW = 150;

export { CLAUDE_BILLING_HEADER_PREFIX };

/**
 * Fingerprint: SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]
 * Matches Claude Code's computeFingerprint in utils/fingerprint.ts.
 * Uses chars from the first *user* message (not the system prompt).
 */
export function createClaudeBillingHeader(firstUserMessageText: string): string {
	const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? "0").join("");
	const versionSuffix = nodeCrypto
		.createHash("sha256")
		.update(`59cf53e54c78${k}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=claude-desktop; ${CCH_PLACEHOLDER_STR};`;
}

// --- xxHash64, pure JS -----------------------------------------------------
// omp calls Bun.hash.xxHash64(body, seed). Node has no equivalent, so this is
// a faithful BigInt implementation of XXH64. Verified against the canonical
// test vectors (see verify-xxhash.ts).

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const MASK = 0xffffffffffffffffn;

const u64 = (v: bigint) => v & MASK;
const rotl = (v: bigint, r: bigint) => u64((v << r) | (v >> (64n - r)));

function round(acc: bigint, input: bigint): bigint {
	return u64(rotl(u64(acc + u64(input * P2)), 31n) * P1);
}

function mergeRound(acc: bigint, val: bigint): bigint {
	const v = round(0n, val);
	return u64(u64(u64(acc ^ v) * P1) + P4);
}

function avalanche(h: bigint): bigint {
	h = u64(h ^ (h >> 33n));
	h = u64(h * P2);
	h = u64(h ^ (h >> 29n));
	h = u64(h * P3);
	return u64(h ^ (h >> 32n));
}

/** XXH64 over `input` with `seed`. Pure-JS replacement for Bun.hash.xxHash64. */
export function xxHash64(input: Uint8Array, seed: bigint): bigint {
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const len = input.length;
	let p = 0;
	let h: bigint;

	if (len >= 32) {
		let v1 = u64(seed + P1 + P2);
		let v2 = u64(seed + P2);
		let v3 = u64(seed);
		let v4 = u64(seed - P1);
		const limit = len - 32;
		do {
			v1 = round(v1, view.getBigUint64(p, true));
			v2 = round(v2, view.getBigUint64(p + 8, true));
			v3 = round(v3, view.getBigUint64(p + 16, true));
			v4 = round(v4, view.getBigUint64(p + 24, true));
			p += 32;
		} while (p <= limit);

		h = u64(rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n));
		h = mergeRound(h, v1);
		h = mergeRound(h, v2);
		h = mergeRound(h, v3);
		h = mergeRound(h, v4);
	} else {
		h = u64(seed + P5);
	}

	h = u64(h + BigInt(len));

	while (p + 8 <= len) {
		h = u64(rotl(u64(h ^ round(0n, view.getBigUint64(p, true))), 27n) * P1 + P4);
		p += 8;
	}
	if (p + 4 <= len) {
		h = u64(rotl(u64(h ^ u64(BigInt(view.getUint32(p, true)) * P1)), 23n) * P2 + P3);
		p += 4;
	}
	while (p < len) {
		h = u64(rotl(u64(h ^ u64(BigInt(input[p]) * P5)), 11n) * P1);
		p += 1;
	}

	return avalanche(h);
}

/**
 * cch attestation: XXHash64(body_with_placeholder, seed) low-20-bits, 5 hex chars,
 * written back over the placeholder in place (matches Claude Code's behaviour).
 */
export function patchCch(body: Uint8Array): "patched" | "no-billing-header" | "unanchored" {
	const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

	const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER);
	if (markerIdx === -1) return "no-billing-header";

	const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
	const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom);
	if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) return "unanchored";

	const h = xxHash64(body, CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	// idx points at "cch=", digits start 4 bytes later.
	for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
	return "patched";
}

type FetchImpl = typeof fetch;

/**
 * Wraps a fetch implementation to patch the Claude Code billing-header `cch`
 * attestation into outgoing request bodies. Bodies without the placeholder pass
 * through untouched, so installing it on every OAuth flow is safe.
 */
export function wrapFetchForCch(base: FetchImpl): FetchImpl {
	return (async (input: any, init?: any) => {
		const body = init?.body;
		if (typeof body === "string") {
			const bytes = cchEncoder.encode(body);
			const result = patchCch(bytes);
			if (result === "patched") {
				return base(input, { ...init, body: Buffer.from(bytes) });
			}
		} else if (body instanceof Uint8Array) {
			const copy = new Uint8Array(body);
			if (patchCch(copy) === "patched") {
				return base(input, { ...init, body: Buffer.from(copy) });
			}
		}
		return base(input, init);
	}) as FetchImpl;
}

// ---------------------------------------------------------------------------
// metadata.user_id cloaking (omp: anthropic.ts lines ~641-742)
// ---------------------------------------------------------------------------

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

// ---------------------------------------------------------------------------
// Tool-name prefixing (omp: anthropic.ts lines ~761-776)
// ---------------------------------------------------------------------------

/**
 * omp isolates custom OAuth tools with a `_` prefix rather than renaming them
 * to Claude Code's built-in tool names (pi's approach). This avoids schema
 * collisions with the server-side built-ins.
 */
export const applyClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	return `${claudeToolPrefix}${name}`;
};

export const stripClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
	return name.slice(claudeToolPrefix.length);
};
