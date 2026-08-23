/**
 * pi's own system prompt (2668 chars) is what Anthropic rejects. 200 chars of it
 * pass, the whole thing fails. Binary-search the cut-off, then look at what sits
 * at that boundary.
 *
 * Run: node --experimental-strip-types bisect-prompt.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeCrypto from "node:crypto";
import { buildCoworkBetas, coworkHeaders, coworkUserAgent, wrapFetchForCch } from "./fingerprint.ts";

const cred = JSON.parse(
	fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"),
)["pi-sub-anthropic"];
const token: string = cred.access;
const betas = [...buildCoworkBetas(true, true)].join(",");
const doFetch = wrapFetchForCch(fetch);
const original = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));
const sys = original.system;
const PROMPT: string = sys[2].text;

const headers = (): Record<string, string> => ({
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
});

async function ok(prompt: string): Promise<boolean> {
	const body = JSON.parse(JSON.stringify(original));
	body.system = [sys[0], sys[1], { type: "text", text: prompt }];
	try {
		const res = await doFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
		});
		await res.text();
		return res.ok;
	} catch {
		return false;
	}
}

console.log(`pi system prompt: ${PROMPT.length} chars\n`);

let lo = 0; // known good
let hi = PROMPT.length; // known bad
console.log("binary searching the first failing prefix length...");
while (hi - lo > 1) {
	const mid = Math.floor((lo + hi) / 2);
	const good = await ok(PROMPT.slice(0, mid));
	console.log(`  ${String(mid).padStart(5)} chars -> ${good ? "200 OK" : "400"}`);
	if (good) lo = mid;
	else hi = mid;
	await new Promise((r) => setTimeout(r, 800));
}

console.log(`\nlast good prefix: ${lo} chars`);
console.log(`first bad prefix: ${hi} chars`);
console.log(`\n--- context around the boundary (chars ${Math.max(0, lo - 160)}..${hi + 60}) ---`);
console.log(JSON.stringify(PROMPT.slice(Math.max(0, lo - 160), hi + 60)));
console.log(`\n--- the single character added at ${hi}: ---`);
console.log(JSON.stringify(PROMPT[lo]));
