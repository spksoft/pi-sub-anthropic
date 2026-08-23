# AGENTS.md

Guidance for coding agents working in this repository.

## What this project is

`pi-sub-anthropic` is a **pi extension** that registers an extra provider id,
`pi-sub-anthropic`, speaking the Anthropic Messages API. The logic is a **port of
omp** (`@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai`, pinned to v17.4.2) so a
Claude Pro/Max **subscription** OAuth credential is accepted and billed against
plan quota instead of API credits.

pi's built-in `anthropic` provider is never patched or wrapped. This one keeps
its own provider id, its own `auth.json` entry, its own env vars.

Docs are split by audience: `README.md` is user-facing only (install, use, env
vars, troubleshooting), `docs/internals.md` holds the design rationale and the
measured results (wire fingerprint, the diagnosed "out of extra usage" 400 and
its fix), and `CONTRIBUTING.md` holds setup, tests, hard rules, releases and
versioning. Read `docs/internals.md` before making non-trivial changes.

## Layout

| path | role |
|---|---|
| `index.ts` | entry point: `pi.registerProvider("pi-sub-anthropic", …)` + 9-model catalog |
| `stream.ts` | Messages streaming over `fetch`: headers, 64k clamp, tool prefixing, SSE parsing, system-prompt relocation |
| `fingerprint.ts` | pinned omp wire constants, beta profiles, billing header, pure-BigInt XXH64, `cch` patch |
| `oauth.ts` | OAuth login/refresh (PKCE, callback port 54545) + bootstrap identity |
| `wire-test.ts` | 55 assertions against a mock Anthropic HTTP server; no credentials, no network |
| `compare-bun.ts` / `verify-xxhash.ts` | XXH64 conformance (vs bun native / canonical vectors) |
| `diagnostics/*.ts` | one-off probes that need a **live** credential; not part of `npm test` |
| `scripts/link-dev.mjs` | symlinks `node_modules` at an installed pi |
| `.github/workflows/publish.yml` | release-triggered npm publish; the tag sets the version |

## Commands

```bash
npm test          # wire-test.ts  -> expect "55 passed, 0 failed"
npm run test:xxhash
npm run test:bun  # needs bun
npm run test:all
npm run typecheck # tsc --noEmit, must stay at 0 errors
npm run link:dev  # alternative to npm install for type resolution
```

Everything runs under `node --experimental-strip-types` (Node >= 22.6). There is
**no build step**; do not add one.

## Hard rules

1. **Do not change values in `fingerprint.ts` casually.** The `claude-cli`
   version string, `X-Stainless-*` values, beta list, 64k `max_tokens` clamp,
   `_` tool prefix, billing header and `cch` seed are transcribed from omp
   17.4.2 and pinned on purpose. Changing them can silently break subscription
   auth. `X-Stainless-OS`/`X-Stainless-Runtime-Version` are constants by design —
   do not make them host-derived (only `X-Stainless-Arch` is).
2. **Never advertise 1M-context betas on OAuth.** Subscription credentials have
   no long-context credit and Anthropic hard-429s.
3. **OAuth vs API key must stay divergent.** OAuth: clamp `max_tokens`, prefix
   tools, cloak `metadata.user_id`, relocate pi's system prompt into a leading
   `<system-reminder>` user turn. API-key requests keep the full ceiling and the
   prompt in `system`. Tests assert both paths.
4. **TypeScript style is constrained by `tsconfig.json`**: `erasableSyntaxOnly`
   (no enums, namespaces, parameter properties), `verbatimModuleSyntax`
   (`import type` for types), explicit `./foo.ts` import specifiers,
   `noUnusedLocals`/`noUnusedParameters`. Tabs for indentation.
5. **No `@ts-ignore` / `@ts-expect-error`.** The tree currently has zero; keep it
   that way.
6. **Zero runtime dependencies.** Only `typescript` and `@types/node` as
   devDependencies, `@earendil-works/*` as peers. Do not add runtime packages.

## Changing wire behaviour

Any change to the outgoing request must be covered in `wire-test.ts`, which
captures the raw body/headers on a local server and re-verifies `cch`
independently. Run `npm test` and `npm run typecheck` before finishing.

Live-credential experiments belong in `diagnostics/` as a new probe file, with a
header comment stating the hypothesis, the established facts and the run
command — follow the existing files' shape. Never commit tokens or captured
bodies.

## Documentation

Keep the audience split intact: user-visible behaviour changes go to
`README.md`, wire/design changes and their measurements to `docs/internals.md`,
workflow and release changes to `CONTRIBUTING.md`. Match the existing style —
state what was measured, not what is assumed, and record a latent issue rather
than silently fixing it.
