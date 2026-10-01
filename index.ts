/**
 * pi-sub-anthropic — Anthropic provider for pi, ported from omp (oh-my-pi).
 *
 * PORTED CODE. The Anthropic logic here is derived from omp
 * (@oh-my-pi/pi-coding-agent, @oh-my-pi/pi-ai) v17.4.2 — MIT, (c) Mario Zechner,
 * Can Bölük, Stencil Labs, Inc. See README "Attribution".
 *
 * WHAT IT ENABLES
 * The same Anthropic access omp has, inside pi: logging in with a Claude
 * Pro/Max account (`/login pi-sub-anthropic`) bills requests against that
 * SUBSCRIPTION PLAN QUOTA rather than per-token API credits. That works only
 * because the OAuth request reproduces omp's wire fingerprint byte-for-byte —
 * user-agent, beta profile, system-block layout, 64k output clamp, `_` tool
 * prefix, billing header + cch attestation. Change any of those and the
 * subscription credential stops being honoured.
 *
 * Registers a SEPARATE provider id (`pi-sub-anthropic`) so pi's built-in
 * `anthropic` provider is left completely untouched. Existing sessions,
 * models.json entries and `~/.pi/agent/auth.json` credentials keep working
 * exactly as before; this provider stores its own OAuth credential under its
 * own id and can be removed at any time by deleting this directory.
 *
 * USAGE
 *   /login pi-sub-anthropic          # one-time OAuth (Claude Pro/Max subscription)
 *   /model pi-sub-anthropic/claude-opus-5-5
 *
 *   # or with an API key instead (billed as API credits, not the plan):
 *   PI_SUB_ANTHROPIC_API_KEY=sk-ant-... pi
 *
 * WHY THIS EXISTS
 * omp ships raw .ts under node_modules and targets bun, so a pi extension
 * cannot import it (Node: "Stripping types is currently unsupported for files
 * under node_modules"). Its Anthropic logic is therefore ported here in pure
 * Node-compatible TypeScript, including a BigInt XXH64 that replaces bun's
 * native Bun.hash.xxHash64 (verified 836/836 against bun — see compare-bun.ts).
 *
 * DIVERGENCES FROM pi 0.83.0's BUILT-IN ANTHROPIC PROVIDER
 *   token URL      api.anthropic.com/v1/oauth/token   (pi: platform.claude.com)
 *   user-agent     claude-cli/2.1.280 (external, claude-desktop)  (pi: claude-cli/2.1.75)
 *   identity       "You are a Claude agent...Agent SDK"  (pi: "You are Claude Code...")
 *   max_tokens     clamped to 64k on OAuth              (pi: sends model.maxTokens)
 *   tool names     prefixed `_`                         (pi: renamed to Read/Write/Bash)
 *   extras         billing header + cch attestation, X-Stainless-*, bootstrap identity
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginAnthropic, refreshAnthropicToken, type PiSubOAuthCredentials } from "./oauth.ts";
import { createPiSubAnthropicStream } from "./stream.ts";

const PROVIDER_ID = "pi-sub-anthropic";
const BASE_URL = "https://api.anthropic.com";

type ModelSpec = {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** pi level -> Anthropic effort; null hides a level. Mirrors pi's anthropic catalog. */
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Record<string, unknown>;
};

/**
 * Catalog mirrors pi's own models-store.json for the anthropic provider, so
 * `/model pi-sub-anthropic/<id>` offers the same set you already have.
 * `maxTokens` stays at the true model ceiling — the OAuth 64k clamp is applied
 * per-request in stream.ts, exactly as omp does it, so API-key users keep the
 * full ceiling.
 */
const MODELS: ModelSpec[] = [
	{
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-fable-5",
		name: "Claude Fable 5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		thinkingLevelMap: { max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5 (pi-sub)",
		contextWindow: 200000,
		maxTokens: 64000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		compat: { supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 128000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		thinkingLevelMap: { max: "max" },
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (pi-sub)",
		contextWindow: 1000000,
		maxTokens: 64000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		compat: { supportsStrictTools: true },
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5 (pi-sub)",
		contextWindow: 200000,
		maxTokens: 64000,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		compat: { supportsStrictTools: true },
	},
];

export default function (pi: ExtensionAPI) {
	const debug = process.env.PI_SUB_ANTHROPIC_DEBUG === "1";
	const extraBetas = (process.env.PI_SUB_ANTHROPIC_EXTRA_BETAS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	pi.registerProvider(PROVIDER_ID, {
		name: "Anthropic Subscription (pi-sub)",
		baseUrl: BASE_URL,
		api: "anthropic-messages",
		// Falls back to an API key when no OAuth credential is stored.
		apiKey: "$PI_SUB_ANTHROPIC_API_KEY",
		streamSimple: createPiSubAnthropicStream({ extraBetas, debug }),

		oauth: {
			name: "Anthropic Subscription (Claude Pro/Max)",
			login: loginAnthropic,
			refreshToken: (credentials) =>
				refreshAnthropicToken(credentials as PiSubOAuthCredentials),
			getApiKey: (credentials) => credentials.access,
		},

		models: MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			api: "anthropic-messages" as const,
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			thinkingLevelMap: m.thinkingLevelMap,
			compat: m.compat as any,
		})),
	});

	if (debug) {
		process.stderr.write(
			`[pi-sub-anthropic] registered provider "${PROVIDER_ID}" with ${MODELS.length} models\n`,
		);
	}
}
