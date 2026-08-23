# pi-sub-anthropic

A [pi](https://github.com/badlogic/pi-mono) extension that registers a second
Anthropic provider, `pi-sub-anthropic`, which authenticates with a **Claude
Pro/Max subscription** instead of API credits. Ported from
**[omp](https://github.com/can1357/oh-my-pi)** v17.4.2.

---

## ⚠️ Warning — read this first

**This project is not official.** It is not affiliated with, endorsed by, or
supported by either **Anthropic** or the **pi** project. Nobody upstream has
reviewed, blessed, or agreed to maintain it.

**Using it may get your Anthropic account restricted or banned.** To make a
subscription credential work outside Claude Code, this extension reproduces
Claude Code's wire fingerprint byte-for-byte: its user-agent, beta headers,
system-block layout, token clamp, tool naming, and a billing attestation hash.
That is, by construction, presenting a third-party client as a first-party one.

Understand what that means before you install:

- **It may violate Anthropic's Terms of Service / Usage Policies.** Read them
  and decide for yourself. This project takes no position and offers no defence.
- **Detection is trivial for Anthropic and entirely within their control.** They
  can identify, rate-limit, suspend, or terminate accounts at any time, without
  notice, and this extension can do nothing about it.
- **The account at risk is your Claude subscription account** — the same one you
  use in Claude.ai and Claude Code. There is no sandbox and no way to limit the
  blast radius.
- **The fingerprint is pinned and does not self-update.** If Anthropic changes
  anything server-side, requests start failing — possibly conspicuously.
- **No warranty, no support, no liability.** You run this entirely at your own
  risk. If you are not prepared to lose the account, use an API key instead
  (`PI_SUB_ANTHROPIC_API_KEY`) or pi's built-in `anthropic` provider.

If any of that is unacceptable to you, stop here.

---

## Quick start

Needs Node **>= 22.6**, pi **>= 0.83.0**, and a Claude **Pro or Max**
subscription for the OAuth path. pi loads the extension with the Node that runs
pi — not necessarily the `node` first on your `PATH` — and that interpreter must
be >= 22.6 or type stripping fails at load.

### 1. Install

From git (pi clones the repo, runs `npm install`, records the source):

```bash
pi install git:github.com/spksoft/pi-sub-anthropic
```

Or from a local clone, if you intend to edit the code:

```bash
git clone git@github.com:spksoft/pi-sub-anthropic.git
cd pi-sub-anthropic
npm install          # or: npm run link:dev  — reuse an installed pi's node_modules
pi install "$PWD"
```

Or by hand, adding the absolute path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-sub-anthropic"]
}
```

### 2. Log in and pick a model

```bash
/login pi-sub-anthropic                 # OAuth against your Claude subscription
/model pi-sub-anthropic/claude-opus-5
```

Non-interactively:

```bash
pi --provider pi-sub-anthropic --model claude-opus-5
```

To make it the default, in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "pi-sub-anthropic",
  "defaultModel": "claude-opus-5"
}
```

### 3. Verify

```bash
pi --list-models pi-sub-anthropic       # 9 models
pi -p --provider pi-sub-anthropic --model claude-sonnet-5 "hi"
```

`pi auth check --provider pi-sub-anthropic` is **not** a useful probe — those
subcommands resolve providers without loading extensions and answer
`provider_not_found` even when everything works. Look for a `pi-sub-anthropic`
key in `~/.pi/agent/auth.json` instead.

### Models

Nine, mirroring pi's own Anthropic catalog: Opus 5 / 4.8 / 4.7 / 4.6 / 4.5,
Sonnet 5 / 4.6 / 4.5, Haiku 4.5.

### Environment variables

| var | effect |
|---|---|
| `PI_SUB_ANTHROPIC_API_KEY` | use an API key instead of OAuth (billed as API credits) |
| `PI_SUB_ANTHROPIC_DEBUG=1` | print resolved URL / headers / `max_tokens` to stderr (auth redacted) |
| `PI_SUB_ANTHROPIC_EXTRA_BETAS` | comma-separated extra `anthropic-beta` values |
| `PI_SUB_ANTHROPIC_DUMP_BODY` | path to write the outgoing request body to |

### Uninstall

```bash
pi remove git:github.com/spksoft/pi-sub-anthropic
```

Or delete the `extensions[]` line. Nothing else in pi is touched.

---

## How it works

### The shape of it

The extension registers a **separate provider id**. pi's built-in `anthropic`
provider is never patched, wrapped, or monkeyed with — your existing sessions,
model entries and stored credentials keep working exactly as before, and this
provider keeps its own OAuth credential under its own id in
`~/.pi/agent/auth.json`.

There are no runtime npm dependencies. The Messages API is spoken directly over
`fetch`, and the sources run under `node --experimental-strip-types` with no
build step.

| file | role |
|---|---|
| `index.ts` | entry point: `pi.registerProvider("pi-sub-anthropic", …)` + model catalog |
| `oauth.ts` | OAuth login/refresh (PKCE, callback port 54545) + bootstrap identity |
| `stream.ts` | Messages streaming: headers, token clamp, tool prefixing, SSE parsing |
| `fingerprint.ts` | pinned wire constants, beta profiles, billing header, XXH64 |

### Two credentials, two behaviours

| | `/login pi-sub-anthropic` (OAuth) | `PI_SUB_ANTHROPIC_API_KEY` |
|---|---|---|
| Credential | `sk-ant-oat…` subscription token | `sk-ant-api…` key |
| Billed to | **your Claude Pro/Max plan quota** | per-token API credits |
| Auth header | `Authorization: Bearer …` | `X-Api-Key` |
| Identity sent | full Claude Code fingerprint | plain API request |
| `max_tokens` | clamped to 64k | full model ceiling |
| Tool names | prefixed `_` | unchanged |
| System prompt | relocated to a user turn (see below) | left in `system` |

The OAuth flow requests the `user:inference` scope, which is what permits
inference directly against the subscription rather than an issued API key.

### Why the fingerprint matters

Anthropic accepts a subscription token for inference only from a client that
looks like Claude Code. This extension reproduces that appearance:

- **User-agent** `claude-cli/2.1.220 (external, claude-desktop)`.
- **System identity block** — "You are a Claude agent, built on Anthropic's
  Claude Agent SDK."
- **`max_tokens` clamped to 64k on OAuth**, because Claude Code never requests
  more. API-key callers keep the full ceiling (e.g. 128k on Opus 4.8).
- **Tools prefixed with `_`** rather than renamed.
- **A billing header as `system[0]`**, carrying a `cch=…` attestation — an XXH64
  hash over the request bytes, patched in on the wire after serialisation.
- **The full `X-Stainless-*` header set** and a cloaked `metadata.user_id` of the
  form `user_<64hex>_account_<uuid>_session_<uuid>`.
- **Account/org identity** captured at login via `/api/claude_cli/bootstrap`.

These constants live in `fingerprint.ts` and are transcribed from omp 17.4.2.
They look like magic numbers because they are. `X-Stainless-OS` and
`X-Stainless-Runtime-Version` deliberately do **not** describe your host — only
`X-Stainless-Arch` is host-derived, matching omp.

**1M-context betas are never advertised on OAuth.** Subscription credentials
carry no long-context credit balance, so Anthropic hard-429s (*"Usage credits
are required for long context requests"*) on a beta-gated 1M model regardless of
prompt size. Natively-1M models such as `claude-sonnet-5` still serve their full
window.

### The system-prompt relocation

Sending pi's own system prompt on the subscription path produced a hard failure:

```
400 invalid_request_error
"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
```

Diagnosed with a logging proxy (`diagnostics/capture-proxy.ts`) that captured a
genuine succeeding request alongside the failing one, then converged one toward
the other. Headers, auth, attestation, tool prefixing and transport were all
correct on the wire. The rejection keys off the **content** of pi's system
prompt, not its size — 21k chars of Claude-Code-shaped text passes, while pi's
2.4k-char prompt fails, with the bisect boundary inside its run of `docs/*.md`
references.

The reading: a subscription credential presenting the Claude Code fingerprint is
expected to carry a Claude-Code-shaped system prompt. pi's prompt announces a
different product, and that mismatch routes the request to the paid extra-usage
bucket instead of the plan.

**Fix, active by default on OAuth:** the harness prompt is moved out of `system`
and delivered as a leading `<system-reminder>` user turn followed by a synthetic
assistant acknowledgement — which is how omp itself delivers context. Measured
alternatives on a live credential (`diagnostics/fix-probe.ts`):

| strategy | result | cost |
|---|---|---|
| prompt as a `system` block (before) | 400 | — |
| **`<system-reminder>` user turn (chosen)** | **200** | none — prompt sent verbatim |
| rename every `pi` token | 200 | mangles the instructions |
| truncate before the docs section | 200 | loses instructions |

The relocation is the only option that preserves the prompt verbatim, so the
model still receives every instruction. Two synthetic turns are added, and the
prompt is no longer cached as a `system` block — a small prompt-cache
difference. API-key requests are deliberately untouched.

### What is and isn't ported

**Ported:** streaming, OAuth login/refresh, the wire fingerprint, tool naming,
thinking budgets.

**Not ported:** Bedrock / Vertex / Copilot signing routes, fast-mode fallback,
image resizing (`Bun.Image`), server-side fallbacks, structured outputs.

### Tests

```bash
npm run test          # wire-test.ts   -> 55 passed, 0 failed
npm run test:xxhash   # canonical XXH64 vectors, seed 0
npm run test:bun      # 836/836 match bun's native xxHash64  (needs bun)
npm run test:all      # all three
npm run typecheck     # tsc --noEmit, 0 errors
```

`wire-test.ts` starts a local HTTP server impersonating the Messages API, points
the provider at it with a fake OAuth token, and asserts that the outgoing
request carries the expected fingerprint — headers, betas, the 64k clamp,
system-block order, `cch` correctness (recomputed independently from the
transmitted bytes), tool prefixes and the cloaked user id. It also checks that
model-supplied headers cannot clobber enforced ones, and that the SSE response
parses into thinking/text/toolCall content with correct usage and cost. No
credentials and no network access required.

`compare-bun.ts` is the ground truth for the XXH64 port: 4 seeds × 209 inputs
diffed against bun's native implementation. `verify-xxhash.ts` is the bun-free
subset.

`diagnostics/*.ts` are one-off probes that need a **live** credential; they are
not part of `npm test`.

### Publishing

The [pi package gallery](https://pi.dev/packages) is an index of npm, not a
submission queue: publish with the `pi-package` keyword (already in
`package.json`) and the listing appears by itself, using `repository` for its
repo link and `pi install npm:pi-sub-anthropic` as its install command.

```bash
npm login
npm version patch                     # or minor/major; commits and tags
npm publish                           # prepublishOnly runs typecheck + tests
git push --follow-tags
```

`files` restricts the tarball to the four runtime sources plus `README.md` and
`LICENSE` — 7 entries. The `diagnostics/*.ts` probes read
`~/.pi/agent/auth.json` and are deliberately **not** shipped. Verify before and
after packing:

```bash
npm pack --dry-run                    # expect exactly 7 files
tar xzf pi-sub-anthropic-*.tgz -C /tmp
pi -ne -e /tmp/package --list-models pi-sub-anthropic   # 9 models, no settings touched
```

Once published, `pi install npm:pi-sub-anthropic` becomes the primary install
route (add `@<version>` to pin; pinned specs are skipped by `pi update`).
Optional gallery preview: `pi.image` (PNG/JPEG/GIF/WebP) or `pi.video` (MP4,
autoplays on hover and takes precedence over an image) pointing at a public URL.

---

## References and attribution

### This is a port of omp

The Anthropic provider logic here — the OAuth flow, wire fingerprint, beta
profile, token clamp, tool naming, billing header and `cch` attestation — is
**derived from [omp](https://github.com/can1357/oh-my-pi)**
(`@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai`), pinned to **v17.4.2**,
principally from:

- `src/providers/anthropic.ts`
- `src/providers/claude-code-fingerprint.ts`
- `src/registry/oauth/anthropic.ts`

Credit for the behaviour this extension reproduces belongs upstream. This
repository contributes a Node-compatible translation, tests, and documentation —
not the discovery.

### Why a port and not an import

omp ships raw TypeScript under `node_modules` and targets bun. Node refuses:

```
Error: Stripping types is currently unsupported for files under node_modules,
for ".../@oh-my-pi/pi-ai/src/index.ts"
```

So the logic is reimplemented here in Node-compatible TypeScript. The one bun
primitive omp relies on — `Bun.hash.xxHash64`, used for the `cch` attestation —
is replaced by a pure BigInt XXH64 in `fingerprint.ts`, verified byte-identical
against bun's native implementation.

### License

omp is MIT licensed:

```
Copyright (c) 2025      Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026      Stencil Labs, Inc.
```

This port is MIT licensed too — see `LICENSE`, which carries both omp's notice
above and the port's own copyright line.

### Links

| | |
|---|---|
| omp (upstream source of the logic) | https://github.com/can1357/oh-my-pi |
| pi (the host agent) | https://github.com/badlogic/pi-mono |
| Anthropic Messages API | https://docs.anthropic.com/en/api/messages |
| Anthropic Usage Policy | https://www.anthropic.com/legal/aup |
| Anthropic Consumer Terms | https://www.anthropic.com/legal/consumer-terms |

*Not an official Anthropic or pi project. Use at your own risk.*
