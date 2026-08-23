/**
 * A single character flips 200 -> 400, so this is a TOKEN THRESHOLD, not bad
 * content. Two candidate mechanisms:
 *
 *   (a) `fallback-credit-2026-06-01` — literally "when plan quota won't cover
 *       it, bill extra-usage credits". Credits are empty -> "out of extra usage".
 *       My earlier beta sweep passed only because that body was tiny; the betas
 *       were never tested against a body large enough to trip the threshold.
 *   (b) prompt caching — crossing the cache minimum triggers a cache WRITE
 *       (1.25x cost) that may bill to extra usage.
 *
 * Also settles whether the pi prompt is special at all, by padding a SHORT
 * system prompt with an equally long user message.
 *
 * Run: node --experimental-strip-types threshold-probe.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeCrypto from "node:crypto";
import { buildCoworkBetas, coworkHeaders, coworkUserAgent, wrapFetchForCch } from "./fingerprint.ts";

const cred = JSON.parse(
	fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"),
)["omp-anthropic"];
const token: string = cred.access;
const doFetch = wrapFetchForCch(fetch);
const original = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));

const FULL_BETAS = [...buildCoworkBetas(true, true)];

const headers = (betas: string[]): Record<string, string> => ({
	Accept: "application/json",
	"Content-Type": "application/json",
	"User-Agent": coworkUserAgent,
	...coworkHeaders,
	"anthropic-beta": betas.join(","),
	"anthropic-dangerous-direct-browser-access": "true",
	"anthropic-version": "2023-06-01",
	Authorization: `Bearer ${token}`,
	"x-app": "cli",
	"x-client-request-id": nodeCrypto.randomUUID(),
	Connection: "keep-alive",
	"Accept-Encoding": "gzip, deflate, br",
});

async function send(label: string, body: unknown, betas: string[] = FULL_BETAS) {
	try {
		const res = await doFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: headers(betas),
			body: JSON.stringify(body),
		});
		if (res.ok) {
			console.log(`  200 OK    ${label}`);
			return true;
		}
		const text = await res.text();
		let msg = text;
		try {
			msg = JSON.parse(text).error?.message ?? text;
		} catch {}
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 95)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 80)}`);
		return false;
	}
}

const clone = () => JSON.parse(JSON.stringify(original));

function stripCacheControl(obj: any): any {
	if (Array.isArray(obj)) return obj.map(stripCacheControl);
	if (obj && typeof obj === "object") {
		const out: any = {};
		for (const [k, v] of Object.entries(obj)) {
			if (k === "cache_control") continue;
			out[k] = stripCacheControl(v);
		}
		return out;
	}
	return obj;
}

console.log("Hypothesis tests against the FULL failing body:\n");

// (a) beta sweep, this time on the body that actually fails.
await send("full body, drop fallback-credit-2026-06-01", clone(), FULL_BETAS.filter((b) => b !== "fallback-credit-2026-06-01"));
await new Promise((r) => setTimeout(r, 800));

await send("full body, drop context-management-2025-06-27", clone(), FULL_BETAS.filter((b) => b !== "context-management-2025-06-27"));
await new Promise((r) => setTimeout(r, 800));

await send("full body, drop prompt-caching-scope-2026-01-05", clone(), FULL_BETAS.filter((b) => b !== "prompt-caching-scope-2026-01-05"));
await new Promise((r) => setTimeout(r, 800));

await send("full body, ONLY claude-code + oauth betas", clone(), ["claude-code-20250219", "oauth-2025-04-20"]);
await new Promise((r) => setTimeout(r, 800));

await send("full body, NO anthropic-beta header at all", clone(), []);
await new Promise((r) => setTimeout(r, 800));

// (b) prompt caching.
await send("full body, ALL cache_control stripped everywhere", stripCacheControl(clone()));
await new Promise((r) => setTimeout(r, 800));

// Is the pi prompt special, or is it just size?
{
	const b = clone();
	b.system = [b.system[0], b.system[1], { type: "text", text: "You are a helpful assistant." }];
	b.messages = [{ role: "user", content: "x ".repeat(1400) }]; // ~2800 chars of user text
	await send("SHORT system prompt + long padded user message", b);
	await new Promise((r) => setTimeout(r, 800));
}

// max_tokens interaction at the threshold.
{
	const b = clone();
	b.max_tokens = 4096;
	delete b.thinking;
	await send("full body, max_tokens=4096, no thinking", b);
}
