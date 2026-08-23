/**
 * Verifies the pure-JS XXH64 port in fingerprint.ts.
 *
 * omp calls `Bun.hash.xxHash64(body, seed)` for the cch attestation. This
 * extension runs under Node, which has no equivalent, so fingerprint.ts
 * reimplements XXH64 in BigInt.
 *
 * GROUND TRUTH: `bun compare-bun.ts` diffs this implementation against bun's
 * native xxHash64 across 4 seeds x 209 inputs (every length 0..200 plus a 20KB
 * body) — 836/836 match. That is the authoritative check, because bun's is the
 * function omp actually calls.
 *
 * This file keeps only the canonical seed-0 vectors from the reference
 * implementation (Cyan4973/xxHash) as a bun-free smoke test:
 *   node --experimental-strip-types verify-xxhash.ts
 */

import { xxHash64 } from "./fingerprint.ts";

const enc = new TextEncoder();
const hex = (v: bigint) => v.toString(16).padStart(16, "0");

// Canonical XXH64 seed-0 vectors, each independently confirmed against bun.
const vectors: Array<[string, bigint, string]> = [
	["", 0n, "ef46db3751d8e999"],
	["a", 0n, "d24ec4f1a98c6e5b"],
	["abc", 0n, "44bc2cf5ad770999"],
	["message digest", 0n, "066ed728fceeb3be"],
	["abcdefghijklmnopqrstuvwxyz", 0n, "cfe1f278fa89835c"],
	[
		"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
		0n,
		"e04a477f19ee145d",
	],
];

let failed = 0;
for (const [input, seed, expected] of vectors) {
	const actual = hex(xxHash64(enc.encode(input), seed));
	const ok = actual === expected;
	if (!ok) failed++;
	console.log(
		`${ok ? "PASS" : "FAIL"}  len=${String(input.length).padStart(2)}  got=${actual} want=${expected}`,
	);
}

console.log(
	failed === 0
		? "\nALL VECTORS PASS (run `bun compare-bun.ts` for the full 836-case bun diff)"
		: `\n${failed} VECTOR(S) FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
