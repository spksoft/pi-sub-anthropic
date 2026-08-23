/**
 * Ground truth from the capture proxy:
 *   omp  -> POST /v1/messages?beta=true   200 OK
 *   mine -> POST /v1/messages             400 "out of extra usage"
 *
 * cch IS patched correctly on the wire (9d814), so that theory is dead. The
 * structural differences that remain:
 *   1. the `?beta=true` query flag        <-- omp always hits the beta endpoint
 *   2. thinking: adaptive+display vs enabled+budget_tokens
 *   3. output_config: { effort } present in omp, absent in mine
 *   4. context_management present in omp, absent in mine
 *   5. metadata.user_id: JSON object vs the user_/account_/session_ string
 *   6. a 4th system block (PROJECT/workstation) in omp
 *
 * Apply them one at a time to the failing body and find which flips it to 200.
 *
 * Run: node --experimental-strip-types endpoint-probe.ts
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
const omp = JSON.parse(fs.readFileSync("/tmp/omp-captured.json", "utf8"));

const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
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
	"Accept-Encoding": "gzip, deflate, br, zstd",
	...extra,
});

async function send(label: string, body: unknown, qs = "", extraHeaders = {}) {
	try {
		const res = await doFetch(`https://api.anthropic.com/v1/messages${qs}`, {
			method: "POST",
			headers: headers(extraHeaders),
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
		console.log(`  ${res.status} FAIL  ${label}\n            -> ${msg.slice(0, 88)}`);
		return false;
	} catch (e) {
		console.log(`  ERR       ${label} -> ${String(e).slice(0, 80)}`);
		return false;
	}
}

const clone = () => JSON.parse(JSON.stringify(original));
const sessionId = nodeCrypto.randomUUID();

console.log("Applying omp's structural differences one at a time:\n");

await send("baseline (mine, unchanged)", clone());
await new Promise((r) => setTimeout(r, 800));

await send("+ ?beta=true query flag", clone(), "?beta=true");
await new Promise((r) => setTimeout(r, 800));

{
	const b = clone();
	b.thinking = { type: "adaptive", display: "summarized" };
	b.output_config = { effort: "max" };
	await send("+ adaptive thinking + output_config.effort", b);
	await new Promise((r) => setTimeout(r, 800));
}

{
	const b = clone();
	b.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
	await send("+ context_management", b);
	await new Promise((r) => setTimeout(r, 800));
}

{
	const b = clone();
	b.metadata = {
		user_id: JSON.stringify({
			session_id: sessionId,
			account_uuid: cred.accountId ?? nodeCrypto.randomUUID(),
			device_id: nodeCrypto.randomBytes(32).toString("hex"),
		}),
	};
	await send("+ omp-shaped metadata.user_id (JSON)", b);
	await new Promise((r) => setTimeout(r, 800));
}

await send(
	"+ X-Claude-Code-Session-Id header",
	clone(),
	"",
	{ "X-Claude-Code-Session-Id": sessionId },
);
await new Promise((r) => setTimeout(r, 800));

// Everything at once.
{
	const b = clone();
	b.thinking = { type: "adaptive", display: "summarized" };
	b.output_config = { effort: "max" };
	b.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
	b.metadata = {
		user_id: JSON.stringify({
			session_id: sessionId,
			account_uuid: cred.accountId ?? nodeCrypto.randomUUID(),
			device_id: nodeCrypto.randomBytes(32).toString("hex"),
		}),
	};
	await send("ALL omp differences combined + ?beta=true", b, "?beta=true", {
		"X-Claude-Code-Session-Id": sessionId,
	});
	await new Promise((r) => setTimeout(r, 800));
}

// Sanity: omp's own captured body replayed by us. Does it still pass?
{
	const b = JSON.parse(JSON.stringify(omp.body));
	await send("omp's OWN captured body, replayed by this port", b, "?beta=true", {
		"X-Claude-Code-Session-Id": omp.headers["x-claude-code-session-id"] ?? sessionId,
	});
}
