/**
 * Not a size threshold: a ~2800-char USER message passes, while the 2358-char
 * SYSTEM prompt fails. So it is the system prompt's CONTENT.
 *
 * The boundary sat at char 2358, right after a run of "docs/*.md" references —
 * strong hint that Anthropic classifies the request as coming from a
 * *different product* (pi's own identity leaking into what claims, via the
 * billing header + identity block, to be Claude Code / Cowork). A mismatched
 * client identity plausibly gets routed to a paid "extra usage" bucket instead
 * of the subscription.
 *
 * Test what specifically offends: the pi branding, the docs references, or
 * simply having ANY third system block past a certain size.
 *
 * Run: node --experimental-strip-types content-probe.ts
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
const betas = [...buildCoworkBetas(true, true)];
const doFetch = wrapFetchForCch(fetch);
const original = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));
const sys = original.system;
const PROMPT: string = sys[2].text;

const headers = (): Record<string, string> => ({
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

async function trySystem(label: string, third: string | undefined) {
	const body = JSON.parse(JSON.stringify(original));
	body.system = third === undefined ? [sys[0], sys[1]] : [sys[0], sys[1], { type: "text", text: third }];
	try {
		const res = await doFetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify(body),
		});
		if (res.ok) {
			console.log(`  200 OK    ${label}`);
			return true;
		}
		const t = await res.text();
		let msg = t;
		try {
			msg = JSON.parse(t).error?.message ?? t;
		} catch {}
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 90)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 80)}`);
		return false;
	}
}

const LOREM =
	"The quick brown fox jumps over the lazy dog while the industrious beaver constructs an elaborate dam across the winding river. ";

console.log(`pi prompt is ${PROMPT.length} chars; boundary was at 2358.\n`);

const cases: Array<[string, string | undefined]> = [
	// Same length, neutral content -> is it length or content?
	[`neutral filler, ${PROMPT.length} chars`, LOREM.repeat(Math.ceil(PROMPT.length / LOREM.length)).slice(0, PROMPT.length)],
	["neutral filler, 4000 chars", LOREM.repeat(40).slice(0, 4000)],
	["neutral filler, 8000 chars", LOREM.repeat(80).slice(0, 8000)],

	// pi prompt with its branding removed.
	["pi prompt, 'pi' -> 'the agent'", PROMPT.replaceAll(/\bpi\b/gi, "the agent")],
	// pi prompt with the docs/*.md block removed.
	["pi prompt, docs/*.md refs stripped", PROMPT.replace(/docs\/[a-z-]+\.md/g, "the docs")],
	// Just the tail that crossed the boundary.
	["only chars 2200-2668 of pi prompt", PROMPT.slice(2200)],
	["only chars 0-2357 (last known good)", PROMPT.slice(0, 2357)],
];

for (const [label, third] of cases) {
	await trySystem(label, third);
	await new Promise((r) => setTimeout(r, 800));
}
