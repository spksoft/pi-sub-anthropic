/**
 * Wire-level test for the pi-sub-anthropic port.
 *
 * Spins up a local HTTP server that impersonates the Anthropic Messages API,
 * points the ported stream function at it with a fake OAuth token, and asserts
 * that the outgoing request carries omp's fingerprint (not pi's) — then feeds
 * a real SSE stream back to check event parsing.
 *
 * Requires no credentials. Run:
 *   node --experimental-strip-types wire-test.ts
 */

import http from "node:http";
import { createPiSubAnthropicStream } from "./stream.ts";
import { CLAUDE_BILLING_HEADER_PREFIX, xxHash64 } from "./fingerprint.ts";

let captured: { headers: Record<string, string>; body: any; rawBody: string } | null = null;

const SSE = [
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pondering" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "_read_file" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"/tmp/x"}' } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 2 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 47 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const server = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		captured = {
			headers: req.headers as Record<string, string>,
			body: JSON.parse(raw),
			rawBody: raw,
		};
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(SSE);
	});
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as any).port;

const model: any = {
	id: "claude-opus-4-5",
	name: "Claude Opus 4.5 (pi-sub)",
	api: "anthropic-messages",
	provider: "pi-sub-anthropic",
	baseUrl: `http://127.0.0.1:${port}`,
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 200000,
	maxTokens: 128000, // deliberately ABOVE the 64k OAuth ceiling
	compat: {},
};

const context: any = {
	systemPrompt: "You are a helpful assistant for the wire test.",
	messages: [
		{ role: "user", content: "First user message used as fingerprint seed" },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_0", name: "read_file", arguments: { path: "/a" } }],
		},
		{ role: "toolResult", toolCallId: "toolu_0", content: [{ type: "text", text: "contents" }], isError: false },
	],
	tools: [
		{ name: "read_file", description: "Read a file", parameters: { properties: { path: { type: "string" } }, required: ["path"] } },
		{ name: "bash", description: "Run a command", parameters: { properties: { cmd: { type: "string" } }, required: ["cmd"] } },
	],
};

const stream = createPiSubAnthropicStream()(model, context, {
	apiKey: "sk-ant-oat01-FAKE-TOKEN-FOR-WIRE-TEST",
	reasoning: "high",
} as any);

const events: string[] = [];
let final: any;
for await (const ev of stream) {
	events.push(ev.type);
	if (ev.type === "done") final = ev.message;
	if (ev.type === "error") final = ev.error;
}
server.close();

// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = "") {
	if (cond) {
		pass++;
		console.log(`  PASS  ${label}`);
	} else {
		fail++;
		console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
	}
}

const h = captured!.headers;
const b = captured!.body;

console.log("\n=== REQUEST HEADERS (omp fingerprint) ===");
check("User-Agent is Cowork claude-desktop", h["user-agent"] === "claude-cli/2.1.220 (external, claude-desktop)", h["user-agent"]);
check("Authorization uses Bearer (not x-api-key)", (h.authorization ?? "").startsWith("Bearer sk-ant-oat01"));
check("no x-api-key header on OAuth", h["x-api-key"] === undefined);
check("x-app: cli", h["x-app"] === "cli");
check("anthropic-version present", h["anthropic-version"] === "2023-06-01");
check("x-client-request-id is a uuid", /^[0-9a-f-]{36}$/.test(h["x-client-request-id"] ?? ""));
check("X-Stainless-Runtime: node", h["x-stainless-runtime"] === "node");
check("X-Stainless-Package-Version: 0.94.0", h["x-stainless-package-version"] === "0.94.0");
check("Connection: keep-alive", (h.connection ?? "").includes("keep-alive"));

const betas = (h["anthropic-beta"] ?? "").split(",");
console.log(`\n  betas: ${h["anthropic-beta"]}`);
check("beta claude-code-20250219", betas.includes("claude-code-20250219"));
check("beta interleaved-thinking-2025-05-14", betas.includes("interleaved-thinking-2025-05-14"));
check("beta context-management-2025-06-27", betas.includes("context-management-2025-06-27"));
check("beta effort-2025-11-24 (thinking requested)", betas.includes("effort-2025-11-24"));
check("beta fallback-credit-2026-06-01", betas.includes("fallback-credit-2026-06-01"));
check("context-1m NOT advertised (omp: hard-429 on OAuth)", !betas.some((x) => x.startsWith("context-1m")));

console.log("\n=== BODY: the max_tokens clamp (pi's divergence) ===");
check("max_tokens clamped to 64000 despite model.maxTokens=128000", b.max_tokens === 64000, `got ${b.max_tokens}`);
check("thinking enabled", b.thinking?.type === "enabled");
check("budget_tokens < max_tokens", b.thinking?.budget_tokens < b.max_tokens, `${b.thinking?.budget_tokens} vs ${b.max_tokens}`);

console.log("\n=== BODY: Cowork system blocks ===");
check("system[0] is the billing header", String(b.system?.[0]?.text ?? "").startsWith(CLAUDE_BILLING_HEADER_PREFIX));
check("system[0] carries cc_entrypoint=claude-desktop", String(b.system?.[0]?.text).includes("cc_entrypoint=claude-desktop"));
check("system[1] is Claude Agent SDK identity", b.system?.[1]?.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
check("system[1] is NOT pi's 'You are Claude Code' string", !String(b.system?.[1]?.text).includes("official CLI"));
check("system has ONLY billing + identity on OAuth", b.system?.length === 2, `got ${b.system?.length} blocks`);
check("caller's prompt is NOT in system (would bill extra usage)", !b.system?.some((s: any) => String(s.text).includes("wire test")));
check("caller's prompt relocated to a <system-reminder> user turn", String(b.messages?.[0]?.content ?? "").includes("<system-reminder>") && String(b.messages?.[0]?.content ?? "").includes("You are a helpful assistant for the wire test."));
check("relocated prompt is followed by a synthetic assistant ack", b.messages?.[1]?.role === "assistant");
check("original first user message preserved after relocation", JSON.stringify(b.messages?.[2] ?? {}).includes("First user message"));

console.log("\n=== BODY: cch attestation patched on the wire ===");
const cchMatch = /cch=([0-9a-f]{5})/.exec(captured!.rawBody);
check("cch present in transmitted body", !!cchMatch);
check("cch is NOT the 00000 placeholder", cchMatch?.[1] !== "00000", `cch=${cchMatch?.[1]}`);
if (cchMatch) {
	// Recompute independently: restore placeholder, hash, compare.
	const restored = captured!.rawBody.replace(/cch=[0-9a-f]{5}/, "cch=00000");
	const expect = (xxHash64(new TextEncoder().encode(restored), 0x4d659218e32a3268n) & 0xfffffn)
		.toString(16)
		.padStart(5, "0");
	check("cch matches independent XXH64 recomputation", cchMatch[1] === expect, `wire=${cchMatch[1]} recomputed=${expect}`);
}

console.log("\n=== BODY: tool naming (omp prefixes, pi renames) ===");
check("tools prefixed with _", b.tools?.[0]?.name === "_read_file", b.tools?.[0]?.name);
check("second tool prefixed", b.tools?.[1]?.name === "_bash", b.tools?.[1]?.name);
check("NOT renamed to Claude Code built-ins (Read/Bash)", !b.tools?.some((t: any) => t.name === "Read" || t.name === "Bash"));
// Index 3, not 1: the OAuth prompt relocation prepends a <system-reminder> user
// turn plus a synthetic assistant ack ahead of the caller's real messages.
check("assistant tool_use replayed with prefix", b.messages?.[3]?.content?.[0]?.name === "_read_file", b.messages?.[3]?.content?.[0]?.name);
check("metadata.user_id cloaked", /^user_[0-9a-f]{64}_account_/.test(b.metadata?.user_id ?? ""));

console.log("\n=== HEADER ENFORCEMENT (model.headers must not clobber fingerprint) ===");
{
	let hijacked: Record<string, string> = {};
	const srv = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			hijacked = req.headers as any;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(SSE);
		});
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
	const p2 = (srv.address() as any).port;
	const evilModel = {
		...model,
		baseUrl: `http://127.0.0.1:${p2}`,
		headers: {
			"User-Agent": "evil/1.0",
			"anthropic-beta": "evil-beta",
			"X-Custom-Allowed": "keepme",
		},
	};
	const s2 = createPiSubAnthropicStream()(evilModel as any, context, {
		apiKey: "sk-ant-oat01-FAKE",
		reasoning: "high",
	} as any);
	for await (const _ of s2) {
		/* drain */
	}
	srv.close();
	check("model.headers cannot override User-Agent", hijacked["user-agent"] === "claude-cli/2.1.220 (external, claude-desktop)", hijacked["user-agent"]);
	check("model.headers cannot override anthropic-beta", hijacked["anthropic-beta"] !== "evil-beta");
	check("non-enforced custom header still passes through", hijacked["x-custom-allowed"] === "keepme");
}

console.log("\n=== UNKNOWN stop_reason MUST NOT BECOME A SUCCESSFUL done ===");
{
	// If Anthropic introduces a stop_reason we don't map, mapStopReason() yields
	// "error". pi's contract (docs/custom-provider.md) says such a turn must be
	// pushed as an `error` event — pushing `done` would make the agent act on a
	// failed response as if it had succeeded.
	const badSse = [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "some_future_reason_2027" }, usage: { output_tokens: 3 } })}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	].join("");

	const srv3 = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(badSse);
		});
	});
	await new Promise<void>((r) => srv3.listen(0, "127.0.0.1", () => r()));
	const p3 = (srv3.address() as any).port;

	const s3 = createPiSubAnthropicStream()(
		{ ...model, baseUrl: `http://127.0.0.1:${p3}` } as any,
		context,
		{ apiKey: "sk-ant-oat01-FAKE" } as any,
	);
	const seen: string[] = [];
	for await (const ev of s3) seen.push(ev.type);
	srv3.close();

	check("emits error, not done, on unknown stop_reason", seen.includes("error") && !seen.includes("done"), seen.join(","));
}

console.log("\n=== API-KEY PATH IS UNAFFECTED BY THE OAUTH RELOCATION ===");
{
	// The relocation exists only to keep subscription requests billable to the
	// plan. API-key requests must keep the prompt in `system` and must not gain
	// the synthetic turns.
	let apiKeyBody: any;
	const srv4 = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			apiKeyBody = JSON.parse(raw);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(SSE);
		});
	});
	await new Promise<void>((r) => srv4.listen(0, "127.0.0.1", () => r()));
	const p4 = (srv4.address() as any).port;

	const s4 = createPiSubAnthropicStream()(
		{ ...model, baseUrl: `http://127.0.0.1:${p4}` } as any,
		context,
		{ apiKey: "sk-ant-api03-NOT-AN-OAUTH-TOKEN" } as any,
	);
	for await (const _ of s4) {
		/* drain */
	}
	srv4.close();

	check("api-key: prompt stays in system", apiKeyBody?.system?.[0]?.text === "You are a helpful assistant for the wire test.", JSON.stringify(apiKeyBody?.system?.[0]?.text)?.slice(0, 60));
	check("api-key: no billing header injected", !String(apiKeyBody?.system?.[0]?.text).includes("x-anthropic-billing-header"));
	check("api-key: no <system-reminder> turn prepended", !String(apiKeyBody?.messages?.[0]?.content ?? "").includes("<system-reminder>"));
	check("api-key: tools NOT prefixed", apiKeyBody?.tools?.[0]?.name === "read_file", apiKeyBody?.tools?.[0]?.name);
	check("api-key: max_tokens keeps full model ceiling", apiKeyBody?.max_tokens === 128000, String(apiKeyBody?.max_tokens));
}

console.log("\n=== RESPONSE PARSING ===");
check("stream produced a done event", events.includes("done"), events.join(","));
check("thinking captured", final?.content?.[0]?.thinking === "pondering");
check("thinking signature captured", final?.content?.[0]?.thinkingSignature === "sig123");
check("text captured", final?.content?.[1]?.text === "Hello world");
check("tool call name UNPREFIXED on the way back", final?.content?.[2]?.name === "read_file", final?.content?.[2]?.name);
check("tool args parsed from partial json", final?.content?.[2]?.arguments?.path === "/tmp/x");
check("stopReason mapped tool_use -> toolUse", final?.stopReason === "toolUse", final?.stopReason);
check("usage input captured", final?.usage?.input === 12);
check("usage output updated from message_delta", final?.usage?.output === 47);
check("cache tokens captured", final?.usage?.cacheRead === 3 && final?.usage?.cacheWrite === 4);
check("cost computed", (final?.usage?.cost?.total ?? 0) > 0, String(final?.usage?.cost?.total));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
