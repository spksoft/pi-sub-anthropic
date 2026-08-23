/**
 * Replays the EXACT body that the provider sent and got a 400 for, then bisects
 * it field by field to find the one Anthropic rejects.
 *
 * Reads /tmp/fail-body.json (written by PI_SUB_ANTHROPIC_DUMP_BODY).
 * Run: node --experimental-strip-types replay-probe.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeCrypto from "node:crypto";
import {
	buildCoworkBetas,
	coworkHeaders,
	coworkUserAgent,
	wrapFetchForCch,
} from "./fingerprint.ts";

const cred = JSON.parse(
	fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"),
)["pi-sub-anthropic"];
const token: string = cred.access;
const betas = [...buildCoworkBetas(true, true)].join(",");
const doFetch = wrapFetchForCch(fetch);
const original = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));

function headers(): Record<string, string> {
	return {
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
}

async function send(label: string, body: unknown) {
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
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 110)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 90)}`);
		return false;
	}
}

const clone = () => JSON.parse(JSON.stringify(original));
const drop = (k: string) => {
	const b = clone();
	delete b[k];
	return b;
};

console.log("Replaying the exact failing body, then bisecting:\n");

await send("EXACT failing body, replayed verbatim", original);
await new Promise((r) => setTimeout(r, 700));

for (const key of ["tools", "thinking", "metadata", "system"]) {
	await send(`without "${key}"`, drop(key));
	await new Promise((r) => setTimeout(r, 700));
}

// Tools present but unprefixed (does the "_" prefix matter?).
{
	const b = clone();
	b.tools = b.tools.map((t: any) => ({ ...t, name: t.name.replace(/^_/, "") }));
	await send("tools WITHOUT the _ prefix", b);
	await new Promise((r) => setTimeout(r, 700));
}

// System reduced to the identity block only (drop billing header).
{
	const b = clone();
	b.system = b.system.slice(1);
	await send("system WITHOUT the billing header block", b);
	await new Promise((r) => setTimeout(r, 700));
}

// Billing header present but cch left as the literal placeholder.
{
	const b = clone();
	b.system[0].text = b.system[0].text.replace(/cch=[0-9a-f]{5}/, "cch=00000");
	await send("billing header with UNPATCHED cch=00000", b);
	await new Promise((r) => setTimeout(r, 700));
}

await send("minimal: model + messages + max_tokens only", {
	model: original.model,
	messages: original.messages,
	max_tokens: 64000,
	stream: true,
});
