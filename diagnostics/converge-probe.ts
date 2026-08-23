/**
 * Ground truth established:
 *   - omp's exact captured body, replayed from THIS process -> 200 OK
 *   - my provider's body                                     -> 400
 * So headers/auth/cch/transport are all fine. It is the BODY.
 *
 * Walk from omp's working body toward mine, one field at a time, and find the
 * mutation that flips 200 -> 400.
 *
 * Run: node --experimental-strip-types converge-probe.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import nodeCrypto from "node:crypto";
import { coworkHeaders, wrapFetchForCch } from "./fingerprint.ts";

const cred = JSON.parse(
	fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"),
)["pi-sub-anthropic"];
const cap = JSON.parse(fs.readFileSync("/tmp/omp2.json", "utf8"));
const mine = JSON.parse(fs.readFileSync("/tmp/fail-body.json", "utf8"));
const doFetch = wrapFetchForCch(fetch);

const H = (): Record<string, string> => ({
	Accept: "application/json",
	"Content-Type": "application/json",
	"User-Agent": cap.headers["user-agent"],
	...coworkHeaders,
	"anthropic-beta": cap.headers["anthropic-beta"],
	"anthropic-dangerous-direct-browser-access": "true",
	"anthropic-version": "2023-06-01",
	Authorization: `Bearer ${cred.access}`,
	"x-app": "cli",
	"x-client-request-id": nodeCrypto.randomUUID(),
	Connection: "keep-alive",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"X-Claude-Code-Session-Id": cap.headers["x-claude-code-session-id"],
});

async function send(label: string, body: unknown, qs = cap.path) {
	try {
		const res = await doFetch(`https://api.anthropic.com${qs}`, {
			method: "POST",
			headers: H(),
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
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${String(msg).slice(0, 85)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 75)}`);
		return false;
	}
}

const base = () => JSON.parse(JSON.stringify(cap.body));

console.log("Walking omp's WORKING body toward mine, one field at a time:\n");

await send("omp body verbatim (control)", base());
await new Promise((r) => setTimeout(r, 800));

// 1. swap in my system prompt as the 3rd block
{
	const b = base();
	b.system = [b.system[0], b.system[1], { type: "text", text: mine.system[2].text }];
	await send("omp body + MY system prompt (drops omp's + PROJECT block)", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 2. keep omp's system, swap in my tools
{
	const b = base();
	b.tools = mine.tools;
	await send("omp body + MY tools (4 prefixed)", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 3. my thinking shape
{
	const b = base();
	b.thinking = mine.thinking;
	delete b.output_config;
	await send("omp body + MY thinking (enabled/budget_tokens)", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 4. my metadata shape
{
	const b = base();
	b.metadata = mine.metadata;
	await send("omp body + MY metadata.user_id (cloaked string)", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 5. my messages
{
	const b = base();
	b.messages = mine.messages;
	await send("omp body + MY messages (no <system-reminder>)", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 6. drop context_management
{
	const b = base();
	delete b.context_management;
	await send("omp body - context_management", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 7. add cache_control the way I do
{
	const b = base();
	b.system[b.system.length - 1].cache_control = { type: "ephemeral" };
	await send("omp body + cache_control on last system block", b);
	await new Promise((r) => setTimeout(r, 800));
}

// 8. plain endpoint instead of ?beta=true
await send("omp body verbatim, but POST /v1/messages (no ?beta=true)", base(), "/v1/messages");
