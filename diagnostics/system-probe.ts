/**
 * `system` is the culprit (removing it -> 200). Which block, and why?
 *   [0] billing header  [1] Claude Agent SDK identity  [2] pi's own system prompt
 *
 * Run: node --experimental-strip-types system-probe.ts
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
const betas = [...buildCoworkBetas(true, true)].join(",");
const doFetch = wrapFetchForCch(fetch);
const original = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));
const sys = original.system;

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

async function send(label: string, system: unknown) {
	const body = { ...JSON.parse(JSON.stringify(original)) };
	if (system === undefined) delete body.system;
	else body.system = system;
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
		const text = await res.text();
		let msg = text;
		try {
			msg = JSON.parse(text).error?.message ?? text;
		} catch {}
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 100)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 80)}`);
		return false;
	}
}

const T = (s: string, cache = false) => ({
	type: "text",
	text: s,
	...(cache ? { cache_control: { type: "ephemeral" } } : {}),
});

console.log("Bisecting the three system blocks:\n");

const cases: Array<[string, unknown]> = [
	["[0] billing only", [sys[0]]],
	["[1] identity only", [sys[1]]],
	["[2] pi prompt only", [sys[2]]],
	["[0]+[1] (what my passing probes sent)", [sys[0], sys[1]]],
	["[0]+[1]+[2] (full, what pi sends)", [sys[0], sys[1], sys[2]]],
	["[1]+[2] no billing header", [sys[1], sys[2]]],
	["[0]+[1]+[2] but [2] WITHOUT cache_control", [sys[0], sys[1], T(sys[2].text)]],
	["[0]+[1]+ short custom prompt", [sys[0], sys[1], T("You are a helpful assistant.")]],
	[
		"[0]+[1]+ pi prompt TRUNCATED to 200 chars",
		[sys[0], sys[1], T(sys[2].text.slice(0, 200))],
	],
	["identity as plain Claude Code string + pi prompt", [sys[0], T("You are Claude Code, Anthropic's official CLI for Claude."), sys[2]]],
];

for (const [label, system] of cases) {
	await send(label, system);
	await new Promise((r) => setTimeout(r, 800));
}
