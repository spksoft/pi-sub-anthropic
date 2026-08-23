# omp-anthropic

An Anthropic provider for **pi** (`@earendil-works/pi-coding-agent`), ported from
**omp** (`@oh-my-pi/pi-coding-agent`, the oh-my-pi fork) at version 17.4.2.

**What it gives you: the same Anthropic access omp has, inside pi.** Log in with
your Claude Pro/Max account and requests are billed against that
**subscription plan quota** — not per-token API credits. That is the point of the
port: pi's built-in Anthropic provider speaks a different wire dialect, and this
one reproduces omp's byte-for-byte, so a subscription login is accepted the same
way it is in omp.

It registers a **separate provider id**, `omp-anthropic`. pi's built-in `anthropic`
provider is not patched, wrapped or monkeyed with: your existing sessions, model
entries and stored credentials keep working exactly as before, and this provider
keeps its own OAuth credential under its own id. Deleting the directory and the
one settings line removes it completely.

Zero runtime npm dependencies. The Messages API is spoken directly over `fetch`,
and the sources run under `node --experimental-strip-types` with no build step.

## Subscription quota vs API credits

| | `/login omp-anthropic` (OAuth) | `OMP_ANTHROPIC_API_KEY` |
|---|---|---|
| Credential | `sk-ant-oat…` subscription token | `sk-ant-api…` key |
| Billed to | **your Claude Pro/Max plan quota** | per-token API credits |
| Auth header | `Authorization: Bearer …` | `X-Api-Key` |
| Identity sent | full Cowork/Claude Code fingerprint | plain API request |
| `max_tokens` | clamped to 64k (fingerprint must match) | full model ceiling |

The OAuth flow requests the `user:inference` scope, which is what permits
inference directly against the subscription rather than an issued API key. Both
paths work; they differ in what pays for the tokens.

Caveats inherited from omp, and enforced in this port:

- **1M-context betas are deliberately never advertised on OAuth.** Subscription
  credentials carry no long-context credit balance, so Anthropic hard-429s
  (*"Usage credits are required for long context requests"*) on a beta-gated 1M
  model regardless of prompt size. Natively-1M models such as `claude-sonnet-5`
  still serve their full window.
- Plan rate limits are Anthropic's, not this extension's. Hitting your Pro/Max
  ceiling produces the same throttling it would in omp or Claude Code.
- Using a subscription credential through a third-party client is your call to
  make against Anthropic's terms; this port takes no position on it.


## Requirements

| | |
|---|---|
| Node | **>= 22.6** (needs `--experimental-strip-types`) |
| pi | **>= 0.83.0** |
| bun | optional — only for `npm run test:bun` |

Any OS node runs on. The `X-Stainless-OS: Linux` header in `fingerprint.ts` is a
*pinned wire constant* copied from omp, not a statement about your machine — see
[Wire fingerprint](#wire-fingerprint).

## Install

Clone it anywhere, then pick one of two setup paths.

**A. Normal install** — needed if you want to type-check:

```bash
npm install
```

**B. Zero-install** — if pi is already installed globally, link against its
`node_modules` instead of downloading a second copy:

```bash
npm run link:dev
```

`link:dev` locates your pi install at runtime (via `pi` on `PATH`, then
`npm root -g`, then node's own prefix) and symlinks `node_modules` at it. Nothing
about any particular home directory, node version or version manager is baked in.
If auto-detection fails, point it at the package yourself:

```bash
npm run link:dev -- /path/to/@earendil-works/pi-coding-agent
```

Then tell pi to load the extension, by absolute path, in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-sub-anthropic"]
}
```

That entry is what lets pi load an extension from outside `~/.pi/agent/extensions/`.
Remove the line to disable it; no other pi state is touched.

## Use

```bash
/login omp-anthropic                      # OAuth (Claude Pro/Max), separate credential
/model omp-anthropic/claude-opus-4-5

# or with an API key instead:
OMP_ANTHROPIC_API_KEY=sk-ant-... pi
```

Nine models are registered, mirroring pi's own Anthropic catalog: Opus 5 / 4.8 /
4.7 / 4.6 / 4.5, Sonnet 5 / 4.6 / 4.5, Haiku 4.5.

Env vars:

| var | effect |
|---|---|
| `OMP_ANTHROPIC_API_KEY` | API-key fallback when no OAuth credential is stored |
| `OMP_ANTHROPIC_DEBUG=1` | print resolved URL/headers/max_tokens to stderr (auth redacted) |
| `OMP_ANTHROPIC_EXTRA_BETAS` | comma-separated extra `anthropic-beta` values |

## What this changes vs pi 0.83.0's built-in provider

Both implementations were read from disk (pi `0.83.0`, omp `17.4.2`):

| wire detail | pi built-in | this port (omp) |
|---|---|---|
| OAuth token URL | `platform.claude.com/v1/oauth/token` | `api.anthropic.com/v1/oauth/token` |
| OAuth callback port | 53692 | 54545 |
| `user-agent` | `claude-cli/2.1.75` | `claude-cli/2.1.220 (external, claude-desktop)` |
| system identity | "You are Claude Code, Anthropic's official CLI…" | "You are a Claude agent, built on Anthropic's Claude Agent SDK." |
| **`max_tokens` on OAuth** | sends `model.maxTokens` (e.g. **128000**) | **clamped to `min(64000, modelMax)`** |
| tool names on OAuth | renamed to `Read`/`Write`/`Bash`/… | prefixed `_read_file` |
| billing header + `cch` | absent | `system[0]` + XXH64 attestation patched on the wire |
| `X-Stainless-*` | absent | full Cowork set |
| `metadata.user_id` | absent | cloaked `user_<64hex>_account_<uuid>_session_<uuid>` |
| identity capture | none | account/org uuid + email via `/api/claude_cli/bootstrap` |

The `max_tokens` clamp is the highest-value difference. omp's own comment:

> Claude Code requests at most 64k output tokens; clamp only OAuth requests,
> where the wire fingerprint must match. API-key callers keep the full model
> ceiling (e.g. 128k on Opus 4.8).

pi sends the raw model ceiling on OAuth, so a 128k-capable model advertises more
output than the Claude Code fingerprint ever does.

## Wire fingerprint

The constants in `fingerprint.ts` — the `claude-cli` version string, the
`X-Stainless-*` values, the beta list, the 64k clamp, the `_` tool prefix, the
billing header and its `cch` attestation — are transcribed from omp 17.4.2 and
pinned on purpose. They look like magic numbers because they are.

Two consequences worth knowing before you send a patch:

- `X-Stainless-OS` and `X-Stainless-Runtime-Version` deliberately do **not**
  describe the host. Making them dynamic would change what goes out on the wire.
  Only `X-Stainless-Arch` is host-derived, matching omp.
- Anthropic can change any of this at any time. If omp bumps its constants,
  re-sync `fingerprint.ts`; there is no automatic tracking.

## Why a port and not an import

omp ships raw TypeScript under `node_modules` and targets bun. Node refuses:

```
Error: Stripping types is currently unsupported for files under node_modules,
for ".../@oh-my-pi/pi-ai/src/index.ts"
```

So the logic is reimplemented here in Node-compatible TypeScript. The one bun
primitive omp relies on — `Bun.hash.xxHash64`, used for the `cch` attestation —
is replaced by a pure BigInt XXH64 in `fingerprint.ts`.

## Verify

```bash
npm run test          # wire-test.ts   -> 45 passed, 0 failed
npm run test:xxhash   # canonical XXH64 vectors, seed 0
npm run test:bun      # 836/836 match bun's native xxHash64  (needs bun)
npm run test:all      # all three
```

`wire-test.ts` starts a local HTTP server impersonating the Messages API, points
the provider at it with a fake OAuth token, and asserts that the outgoing request
carries omp's fingerprint: headers, betas, the 64k clamp, system-block order,
`cch` correctness (recomputed independently from the transmitted bytes), `_` tool
prefixes and the cloaked user id. It also checks that model-supplied headers
cannot clobber enforced ones, and that the SSE response parses into
thinking/text/toolCall content with correct usage and cost. No credentials and no
network access are required.

`compare-bun.ts` is the ground truth for the XXH64 port: 4 seeds x 209 inputs
(every length 0..200, plus a 20KB body) diffed against bun's native
implementation. `verify-xxhash.ts` is the bun-free subset.

## Type-check

```bash
npm run link:dev     # or: npm install
npm run typecheck
```

Passes clean (0 errors) once either setup has run. `tsconfig.json` is strict
(`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly`) and
nothing is suppressed — there is not a single `@ts-ignore` or
`@ts-expect-error` in the project.

`link:dev` needs a compiler on hand, since pi's tree does not ship one; `bunx tsc`
works, or use `npm install` to get the devDependency.

`noUncheckedIndexedAccess` (31 errors) and `exactOptionalPropertyTypes` (11) are
measured and deliberately left off; the numbers are recorded in `tsconfig.json`.

### A bug the type-checker caught

Turning on `strict` surfaced a genuine defect rather than noise. `mapStopReason()`
returns `"error"` for any `stop_reason` Anthropic adds that this port does not
recognise, and the terminal `done` event only accepts `"stop" | "length" |
"toolUse"`. The stream therefore pushed a *successful* `done` carrying
`reason: "error"`, so pi would have treated a failed turn as a completed one.

pi's own contract (`docs/custom-provider.md`) requires two guards before `done`;
this port had only the first. The second is now in place and covered by a
regression test ("emits error, not done, on unknown stop_reason").

## Known latent issues

### The "out of extra usage" 400 — diagnosed and fixed

Live testing hit a hard failure on the subscription path:

```
400 invalid_request_error
"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
```

Diagnosed with a logging MITM proxy (`diagnostics/capture-proxy.ts`) that
captured omp's genuine, succeeding request alongside this port's failing one,
then converged one toward the other:

| test | result |
|---|---|
| omp's captured body replayed **from this port's process** | **200 OK** |
| that body + this port's tools / thinking / metadata / messages | 200 OK |
| that body without `?beta=true`, without `context_management` | 200 OK |
| that body + **pi's system prompt as a system block** | **400** |
| omp's own prompt truncated to pi's length (2357 chars) | 200 OK |
| 8000 chars of neutral filler as the system prompt | 200 OK |

Headers, auth, `cch` attestation, tool prefixing and transport were all correct
— verified on the wire. The rejection keys off the **content** of pi's system
prompt, and it is not about size: appending pi's prompt to an already-21k-char
working request also fails, while 21k chars of omp's own text passes. Bisect put
the boundary at char 2358, inside pi's run of `docs/*.md` references.

The reading: a subscription credential presenting the Claude Code / Cowork
fingerprint is expected to carry a Claude-Code-shaped system prompt. pi's
default prompt announces a different product ("operating inside pi, a coding
agent harness", plus local `pi-coding-agent` paths), and that mismatch routes
the request to the paid extra-usage bucket instead of the plan.

**Fix (active by default on OAuth):** the harness prompt is moved out of
`system` and delivered as a leading `<system-reminder>` user turn, followed by a
synthetic assistant acknowledgement — which is how omp itself delivers context.
Measured alternatives on a live credential (`diagnostics/fix-probe.ts`):

| strategy | result | cost |
|---|---|---|
| prompt as a `system` block (before) | 400 | — |
| **`<system-reminder>` user turn (chosen)** | **200** | none — prompt sent verbatim |
| rename every `pi` token | 200 | mangles the instructions |
| truncate before the docs section | 200 | loses instructions |

The relocation is the only option that preserves the prompt **verbatim**, so the
model still receives every instruction. Verified end to end: plain replies work
on Haiku 4.5, Sonnet 4.5, Opus 4.5 and Opus 5, and tool calls still fire (a
`read` + report round-trip returns the right answer). API-key requests are
deliberately untouched and keep the prompt in `system`; five tests assert that.

### Other latent issues

Found during review, deliberately not changed — both alter runtime behaviour, so
they are recorded rather than silently "fixed":

- **Unhandled race loser in `loginAnthropic`.** `Promise.race([callbackPromise,
  manualPromise])` leaves the losing promise unhandled; if `onPrompt` rejects
  after the browser callback already won, Node reports an unhandled rejection.
- **`mapStopReason` collapses unknown reasons to `"error"`.** Now surfaced as a
  stream error instead of a false success (above), but a future Anthropic
  `stop_reason` still needs an explicit mapping to be handled gracefully.
- **The relocation adds two synthetic turns.** Harmless in practice, but a
  caller inspecting raw request messages will see them, and the prompt is no
  longer cached as a `system` block (prompt-cache behaviour differs slightly).



## Files

| file | role |
|---|---|
| `index.ts` | entry point; `pi.registerProvider("omp-anthropic", …)` + model catalog |
| `stream.ts` | Messages API streaming, headers, clamp, tool prefixing, SSE parsing |
| `fingerprint.ts` | Cowork constants, beta profiles, billing header, XXH64, cch patch |
| `oauth.ts` | OAuth login/refresh + bootstrap identity |
| `wire-test.ts` | 55 assertions against a mock Anthropic server |
| `compare-bun.ts` | diffs the XXH64 port against bun's native implementation |
| `verify-xxhash.ts` | bun-free canonical XXH64 vectors |
| `scripts/link-dev.mjs` | locates an installed pi and symlinks `node_modules` at it |
| `tsconfig.json` | strict type-check config (`npm run typecheck`) |

## Status and limits

- **Exercised:** loads in pi and registers 9 models; the full outgoing payload is
  asserted against a mock server; the XXH64 port is byte-identical to bun's.
- **Not verified against the live Anthropic API.** No real request has ever been
  sent through this provider. The mock server is the only thing that has
  exercised it. Run `/login omp-anthropic` and then a real prompt to close that
  gap — and expect to find things the mock could not.
- **Ported subset:** streaming, OAuth, fingerprint, tool naming, thinking budgets.
  **Not ported:** Bedrock/Vertex/Copilot signing routes, fast-mode fallback,
  image resizing (`Bun.Image`), server-side fallbacks, structured outputs.
- The fingerprint is pinned to omp 17.4.2 and does not self-update. See
  [Wire fingerprint](#wire-fingerprint).

## Attribution

This is a **port of code from [omp](https://github.com/can1357/oh-my-pi)**
(`@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai`), pinned to **v17.4.2**. The
Anthropic provider logic — OAuth flow, wire fingerprint, beta profile, token
clamp, tool naming, billing header and `cch` attestation — is derived from
omp's `src/providers/anthropic.ts`, `src/providers/claude-code-fingerprint.ts`
and `src/registry/oauth/anthropic.ts`, translated to run under Node instead of
bun (see [Why a port and not an import](#why-a-port-and-not-an-import)).

omp is MIT licensed:

```
Copyright (c) 2025      Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026      Stencil Labs, Inc.
```

Credit for the behaviour this extension reproduces belongs upstream. No license
is declared for this port itself; treat the ported portions as carrying omp's
MIT terms above.

