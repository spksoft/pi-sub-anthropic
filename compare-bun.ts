// Ground-truth check: compare the pure-JS XXH64 port against bun's native
// Bun.hash.xxHash64 — the exact function omp calls. Run with: bun compare-bun.ts
import { xxHash64 } from "./fingerprint.ts";

/**
 * bun's global, declared locally. This is the only bun-only entry point in the
 * project, and pulling in @types/bun for a single function would drag a second
 * set of global definitions in alongside @types/node. `declare` is type-space
 * only, so this erases to nothing and the runtime call is unchanged.
 */
declare const Bun: { hash: { xxHash64(input: Uint8Array, seed: bigint): bigint } };

const enc = new TextEncoder();
const hex = (v: bigint) => (v & 0xffffffffffffffffn).toString(16).padStart(16, "0");
const CCH_SEED = 0x4d659218e32a3268n;

const samples: string[] = [
  "",
  "a",
  "abc",
  "message digest",
  "abcdefghijklmnopqrstuvwxyz",
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
];
// Add every length 0..200 to exercise all tail paths, plus a big body.
for (let n = 0; n <= 200; n++) samples.push("x".repeat(n));
samples.push(JSON.stringify({ system: [{ type: "text", text: "cch=00000" }] }).repeat(500));

const seeds = [0n, 1n, 0x9e3779b185ebca87n, CCH_SEED];

let fail = 0;
let total = 0;
for (const seed of seeds) {
  for (const s of samples) {
    const bytes = enc.encode(s);
    const mine = hex(xxHash64(bytes, seed));
    const theirs = hex(BigInt.asUintN(64, Bun.hash.xxHash64(bytes, seed)));
    total++;
    if (mine !== theirs) {
      fail++;
      if (fail <= 5) {
        console.log(`MISMATCH len=${bytes.length} seed=${hex(seed)}\n  mine  =${mine}\n  bun   =${theirs}`);
      }
    }
  }
}
console.log(`\n${total - fail}/${total} match bun's native xxHash64`);
console.log(fail === 0 ? "PORT IS BYTE-COMPATIBLE WITH BUN" : `${fail} MISMATCHES`);
process.exit(fail === 0 ? 0 : 1);
