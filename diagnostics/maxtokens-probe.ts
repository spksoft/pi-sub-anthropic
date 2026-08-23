/**
 * The betas are innocent (all 5 combos returned 200). Headers are identical
 * between the working probe and the failing provider. The remaining variable is
 * the BODY — and the loudest difference is max_tokens: the probe sent 16, the
 * provider sends 64000.
 *
 * Hypothesis: on a subscription credential, a large max_tokens is treated as a
 * reservation against remaining plan balance, so Anthropic rejects with
 * "You're out of extra usage" rather than a quota/rate error.
 *
 * Run: node --experimental-strip-types maxtokens-probe.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeCrypto from "node:crypto";
import {
	buildCoworkBetas,
	claudeCodeSystemInstruction,
	coworkHeaders,
	coworkUserAgent,
	createClaudeBillingHeader,
	generateClaudeCloakingUserId,
	wrapFetchForCch,
} from "./fingerprint.ts";

const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
const cred = JSON.parse(fs.readFileSync(authPath, "utf8"))["pi-sub-anthropic"];
const token: string = cred.access;
const doFetch = wrapFetchForCch(fetch);
const betas = [...buildCoworkBetas(true, true)].join(",");

async function probe(model: string, maxTokens: number, thinking: boolean) {
	const body: Record<string, unknown> = {
		model,
		messages: [{ role: "user", content: "hi" }],
		system: [
			{ type: "text", text: createClaudeBillingHeader("hi") },
			{ type: "text", text: claudeCodeSystemInstruction },
		],
		metadata: { user_id: generateClaudeCloakingUserId() },
		max_tokens: maxTokens,
	};
	if (thinking) {
		body.thinking = { type: "enabled", budget_tokens: Math.min(20480, maxTokens - 1024) };
	}
	body.stream = true;

	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		"User-Agent": coworkUserAgent,
		...coworkHeaders,
		"anthropic-beta": betas,
		"anthropic-dangerous-direct-browser-access": "true",
		"anthropic-version": "2023-06-01",
		Authorization: `Bearer ${token}`,
		"x-app": "cli",
		"x-client-request-id": nodeCrypto.randomUUID(),
		Connection: "keep-alive",
		"Accept-Encoding": "gzip, deflate, br",
	};

	const label = `${model.padEnd(20)} max_tokens=${String(maxTokens).padEnd(6)} thinking=${thinking ? "on " : "off"}`;
	try {
		const res = await doFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
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
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 110)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 90)}`);
		return false;
	}
}

console.log("Sweeping max_tokens on a subscription (OAuth) credential:\n");
for (const [model, mt, th] of [
	["claude-haiku-4-5", 16, false],
	["claude-haiku-4-5", 1024, false],
	["claude-haiku-4-5", 8192, false],
	["claude-haiku-4-5", 32000, false],
	["claude-haiku-4-5", 64000, false],
	["claude-haiku-4-5", 64000, true],
	["claude-opus-4-5", 64000, false],
	["claude-opus-4-5", 8192, false],
] as Array<[string, number, boolean]>) {
	await probe(model, mt, th);
	await new Promise((r) => setTimeout(r, 700));
}
