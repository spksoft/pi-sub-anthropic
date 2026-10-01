# Internals

How this extension works and why, with the measurements behind each decision —
for anyone reading or changing the code rather than just installing it.

## Provider shape

The extension registers a **separate provider id**. pi's built-in `anthropic`
provider is never patched, wrapped, or monkeyed with — your existing sessions,
model entries and stored credentials keep working exactly as before, and this
provider keeps its own OAuth credential under its own id in
`~/.pi/agent/auth.json`.

The OAuth flow requests the `user:inference` scope, which is what permits
inference directly against the subscription rather than an issued API key.

## Why the fingerprint exists

Anthropic accepts a subscription token for inference only from a client that
looks like Claude Code. This extension reproduces that appearance:

- **User-agent** `claude-cli/2.1.280 (external, claude-desktop)`.
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

**Exception: the Claude Code version.** omp 17.4.2 pins `2.1.220`. Newer models
reject that with a 400 `claude_code_version_too_old` (*"Claude Code 2.1.220 does
not support this model; version 2.1.280 or newer is required"*), so
`claudeCodeVersion` is bumped to `2.1.280`, the minimum the server named. The
user-agent, the billing header's `cc_version` (and its derived suffix) and the
bootstrap user-agent all derive from that single constant. If a future model
names a higher minimum, bump the constant again.

**1M-context betas are never advertised on OAuth.** Subscription credentials
carry no long-context credit balance, so Anthropic hard-429s (*"Usage credits
are required for long context requests"*) on a beta-gated 1M model regardless of
prompt size. Natively-1M models such as `claude-sonnet-5` still serve their full
window.

## The system-prompt relocation

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
prompt is no longer a cached `system` block — but it is still covered by the
conversation-tail cache breakpoint set in `convertMessages`, so caching is not
lost. Measured on a live credential, two identical tool-enabled requests:

| run | input | cacheWrite | cacheRead |
|---|---|---|---|
| first | 2 | 1060 | 1290 |
| repeat | 2 | 0 | 2350 |

A prefix shorter than Anthropic's minimum cacheable length (1024 tokens on
Sonnet) is not cached at all — a `--no-tools` request measured 701 input tokens
with `cacheWrite: 0`, which is the floor, not the relocation. API-key requests
are deliberately untouched.

Instruction-following through the relocation is verified end to end:
`--append-system-prompt "reply with exactly the single word: BANANA"` returns
`BANANA`, and a tool-driven read of a scratch file returns the token inside it.

### pi >= 0.99: prompt and tools arrive as system messages

pi 0.99 changed the provider contract. `streamSimple` now receives a
`TranscriptContext` with no `systemPrompt` and no `tools`; both ride in
`role: "system"` messages inside `messages` (a leading one, plus later ones that
append content, patch named `sections` and add/remove tools). Reading the old
fields, the provider sent a request with **zero tools and no pi prompt** —
measured on pi 0.99.2 with `claude-opus-5-5`: a 724-byte body, `0 tools`, and the
model answering "I don't have any tools available".

`foldTranscriptSystemMessages` (stream.ts) replays those messages back into
`systemPrompt` + `tools` before anything else runs, mirroring pi-ai's
`getCurrentSystemMessage` / `getSystemMessageText`, so the relocation above then
applies unchanged. It is written locally rather than imported because the pi-ai
this package typechecks against predates the helpers, and a context without
system messages (pi <= 0.98) passes through untouched. After the fold the same
request is 23885 bytes with 4 tools, and the model lists `_read`, `_bash`,
`_edit`, `_write`. Anthropic's mid-conversation system message support is not
used; everything collapses into the single leading `<system-reminder>` turn.

## Ported scope

**Ported:** streaming, OAuth login/refresh, the wire fingerprint, tool naming,
thinking budgets.

**Not ported:** Bedrock / Vertex / Copilot signing routes, fast-mode fallback,
image resizing (`Bun.Image`), server-side fallbacks, structured outputs.

## Why a port and not an import

omp ships raw TypeScript under `node_modules` and targets bun. Node refuses:

```
Error: Stripping types is currently unsupported for files under node_modules,
for ".../@oh-my-pi/pi-ai/src/index.ts"
```

So the logic is reimplemented here in Node-compatible TypeScript. The one bun
primitive omp relies on — `Bun.hash.xxHash64`, used for the `cch` attestation —
is replaced by a pure BigInt XXH64 in `fingerprint.ts`, verified byte-identical
against bun's native implementation.

## Elsewhere

- [`../README.md`](../README.md) — installation and use.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — tests and releases.
