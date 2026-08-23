/**
 * Logging MITM proxy for the Anthropic Messages API.
 *
 * Point a client at it with ANTHROPIC_BASE_URL=http://127.0.0.1:8899 and it
 * records the exact headers + body that client sends, then forwards upstream
 * and streams the real response back untouched.
 *
 * Used to capture omp's genuine subscription request so it can be diffed
 * against this port's request. The Authorization header is redacted in the
 * capture file.
 *
 * Run: node --experimental-strip-types capture-proxy.ts <outfile>
 */

import http from "node:http";
import fs from "node:fs";

const OUT = process.argv[2] ?? "/tmp/captured.json";
const UPSTREAM = "https://api.anthropic.com";
const PORT = 8899;

const server = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", async () => {
		const raw = Buffer.concat(chunks);
		const url = `${UPSTREAM}${req.url}`;

		// Record everything except the bearer token itself.
		const safeHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			safeHeaders[k] = k.toLowerCase() === "authorization" ? "Bearer <redacted>" : String(v);
		}

		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(raw.toString("utf8"));
		} catch {
			parsedBody = raw.toString("utf8").slice(0, 4000);
		}

		// Never clobber an earlier capture: each request gets its own file.
		let outPath = OUT;
		if (fs.existsSync(outPath)) {
			let n = 2;
			const ext = outPath.endsWith(".json") ? ".json" : "";
			const stem = ext ? outPath.slice(0, -5) : outPath;
			while (fs.existsSync(`${stem}.${n}${ext}`)) n++;
			outPath = `${stem}.${n}${ext}`;
		}

		fs.writeFileSync(
			outPath,
			JSON.stringify(
				{ method: req.method, path: req.url, headers: safeHeaders, body: parsedBody },
				null,
				2,
			),
		);
		console.error(`[proxy] captured ${req.method} ${req.url} -> ${outPath} (${raw.length} bytes)`);

		// Forward verbatim, including the real Authorization header.
		const fwdHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			if (["host", "content-length", "connection"].includes(k.toLowerCase())) continue;
			fwdHeaders[k] = String(v);
		}

		try {
			const upstream = await fetch(url, {
				method: req.method,
				headers: fwdHeaders,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
			});
			console.error(`[proxy] upstream status ${upstream.status}`);
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			});
			if (upstream.body) {
				const reader = upstream.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(Buffer.from(value));
				}
			}
			res.end();
		} catch (e) {
			console.error(`[proxy] upstream error: ${e}`);
			res.writeHead(502).end(JSON.stringify({ error: String(e) }));
		}
	});
});

server.listen(PORT, "127.0.0.1", () => {
	console.error(`[proxy] listening on http://127.0.0.1:${PORT}, forwarding to ${UPSTREAM}`);
	console.error(`[proxy] capture file: ${OUT}`);
});
