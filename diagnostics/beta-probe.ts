/**
 * Isolate which anthropic-beta value triggers:
 *   400 invalid_request_error "You're out of extra usage."
 *
 * omp succeeds on the same account, so this is a beta-set divergence, not an
 * account-quota problem. Sends a 1-token request per beta combination and
 * reports status only. The token is read from pi's auth store and never printed.
 *
 * Run: node --experimental-strip-types beta-probe.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	buildCoworkBetas,
	coworkHeaders,
	coworkUserAgent,
	createClaudeBillingHeader,
	claudeCodeSystemInstruction,
	wrapFetchForCch,
	generateClaudeCloakingUserId,
} from "./fingerprint.ts";
import nodeCrypto from "node:crypto";

const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
const cred = auth["pi-sub-anthropic"] ?? auth.anthropic;
if (!cred?.access) {
	console.error("No pi-sub-anthropic credential found. Run: /login pi-sub-anthropic");
	process.exit(1);
}
const token: string = cred.access;
console.log(`credential: ${token.slice(0, 12)}…  expires ${new Date(cred.expires).toISOString()}`);
console.log(`valid: ${cred.expires > Date.now()}\n`);

const FULL = [...buildCoworkBetas(true, true)];
const NO_FALLBACK = FULL.filter((b) => b !== "fallback-credit-2026-06-01");
const NO_EFFORT = FULL.filter((b) => b !== "effort-2025-11-24");
const NEITHER = FULL.filter(
	(b) => b !== "fallback-credit-2026-06-01" && b !== "effort-2025-11-24",
);
const MINIMAL = ["claude-code-20250219", "oauth-2025-04-20"];

const cases: Array<[string, string[]]> = [
	["FULL cowork agent set (what the port sends)", FULL],
	["without fallback-credit-2026-06-01", NO_FALLBACK],
	["without effort-2025-11-24", NO_EFFORT],
	["without both", NEITHER],
	["minimal claude-code + oauth", MINIMAL],
];

const doFetch = wrapFetchForCch(fetch);

async function probe(label: string, betas: string[]) {
	const body = {
		model: "claude-haiku-4-5",
		messages: [{ role: "user", content: "hi" }],
		system: [
			{ type: "text", text: createClaudeBillingHeader("hi") },
			{ type: "text", text: claudeCodeSystemInstruction },
		],
		metadata: { user_id: generateClaudeCloakingUserId() },
		max_tokens: 16,
		stream: true,
	};

	const headers: Record<string, string> = {
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
	};

	try {
		const res = await doFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		if (res.ok) {
			console.log(`  ${res.status} OK      ${label}`);
			return true;
		}
		const text = await res.text();
		let msg = text;
		try {
			msg = JSON.parse(text).error?.message ?? text;
		} catch {}
		console.log(`  ${res.status} FAIL    ${label}\n           -> ${msg.slice(0, 120)}`);
		return false;
	} catch (e) {
		console.log(`  ERR         ${label} -> ${String(e).slice(0, 100)}`);
		return false;
	}
}

for (const [label, betas] of cases) {
	await probe(label, betas);
	await new Promise((r) => setTimeout(r, 700));
}
