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

## Install

Needs Node **>= 22.6**, pi **>= 0.83.0**, and a Claude **Pro or Max**
subscription for the OAuth path. pi loads the extension with the Node that runs
pi — not necessarily the `node` first on your `PATH` — and that interpreter must
be >= 22.6 or type stripping fails at load.

```bash
pi install npm:pi-sub-anthropic          # tracks latest
pi install npm:pi-sub-anthropic@0.1.4    # pinned; pinned specs are skipped by pi update
```

Published from CI with [npm provenance](https://www.npmjs.com/package/pi-sub-anthropic),
so the tarball is attestably built from this repository. Straight from git works
too, if you would rather track the default branch:

```bash
pi install git:github.com/spksoft/pi-sub-anthropic
```

Or by hand, adding the absolute path to a local copy in
`~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-sub-anthropic"]
}
```

No runtime npm dependencies and no build step: the Messages API is spoken
directly over `fetch`, from TypeScript sources pi type-strips at load.

Working on the code instead? See
[CONTRIBUTING.md](https://github.com/spksoft/pi-sub-anthropic/blob/main/CONTRIBUTING.md).

## Use

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

Thirteen models are registered, mirroring pi's own Anthropic catalog: Fable 5.1 /
5, Opus 5.5 / 5 / 4.8 / 4.7 / 4.6 / 4.5, Sonnet 5.5 / 5 / 4.6 / 4.5, Haiku 4.5.

Every thinking level pi's own Anthropic provider offers for a model is offered
here too, including `xhigh` and `max` where the model supports them
(`--thinking max`, or `/model pi-sub-anthropic/claude-opus-5-5:max`). Levels a
model can't do (e.g. `off` on Opus 5.5) are hidden, and pi clamps to the nearest
supported one.

## Two credentials, two behaviours

| | `/login pi-sub-anthropic` (OAuth) | `PI_SUB_ANTHROPIC_API_KEY` |
|---|---|---|
| Credential | `sk-ant-oat…` subscription token | `sk-ant-api…` key |
| Billed to | **your Claude Pro/Max plan quota** | per-token API credits |
| Auth header | `Authorization: Bearer …` | `X-Api-Key` |
| Identity sent | full Claude Code fingerprint | plain API request |
| `max_tokens` | clamped to 64k | full model ceiling |
| Tool names | prefixed `_` | unchanged |
| System prompt | relocated to a user turn | left in `system` |

Both paths work; they differ in what pays for the tokens. Why the OAuth column
looks like that is documented in
[docs/internals.md](https://github.com/spksoft/pi-sub-anthropic/blob/main/docs/internals.md).

## Environment variables

| var | effect |
|---|---|
| `PI_SUB_ANTHROPIC_API_KEY` | use an API key instead of OAuth (billed as API credits) |
| `PI_SUB_ANTHROPIC_DEBUG=1` | print resolved URL / headers / `max_tokens` to stderr (auth redacted) |
| `PI_SUB_ANTHROPIC_EXTRA_BETAS` | comma-separated extra `anthropic-beta` values |
| `PI_SUB_ANTHROPIC_DUMP_BODY` | path to write the outgoing request body to |

## Troubleshooting

**Is it installed?** `pi --list-models pi-sub-anthropic` lists 13 models, and a
real round-trip is `pi -p --provider pi-sub-anthropic --model claude-sonnet-5
"hi"`.

**`pi auth check --provider pi-sub-anthropic` says `provider_not_found`.**
Expected, and not a fault: those subcommands resolve providers without loading
extensions. Look for a `pi-sub-anthropic` key in `~/.pi/agent/auth.json`
instead.

**A 1M-context model 429s with "Usage credits are required for long context
requests".** Subscription credentials carry no long-context credit, so 1M betas
are never advertised on OAuth. Natively-1M models such as `claude-sonnet-5`
still serve their full window; use an API key if you need a beta-gated 1M model.

**Requests started failing after working before.** The fingerprint is pinned and
does not self-update. Check `PI_SUB_ANTHROPIC_DEBUG=1` output, then the
[upstream constants](https://github.com/spksoft/pi-sub-anthropic/blob/main/docs/internals.md#why-the-fingerprint-exists).

**Rate limits.** Plan limits are Anthropic's, not this extension's. Hitting your
Pro/Max ceiling throttles exactly as it would in Claude Code.

## Uninstall

```bash
pi remove npm:pi-sub-anthropic                        # or the git:/path source you installed
```

Or delete the `extensions[]` line. Nothing else in pi is touched; the stored
credential lives under its own id in `~/.pi/agent/auth.json`.

---

## More

| | |
|---|---|
| How it works, and what was measured | [docs/internals.md](https://github.com/spksoft/pi-sub-anthropic/blob/main/docs/internals.md) |
| Development, tests, releases | [CONTRIBUTING.md](https://github.com/spksoft/pi-sub-anthropic/blob/main/CONTRIBUTING.md) |
| Package on npm | https://www.npmjs.com/package/pi-sub-anthropic |
| Listing in the pi gallery | https://pi.dev/packages/pi-sub-anthropic |

## Attribution and license

The Anthropic provider logic here — the OAuth flow, wire fingerprint, beta
profile, token clamp, tool naming, billing header and `cch` attestation — is
**derived from [omp](https://github.com/can1357/oh-my-pi)**
(`@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai`), pinned to **v17.4.2**. Credit
for the behaviour this extension reproduces belongs upstream; this repository
contributes a Node-compatible translation, tests and documentation — not the
discovery.

omp is MIT licensed:

```
Copyright (c) 2025      Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026      Stencil Labs, Inc.
```

This port is MIT licensed too — see [LICENSE](LICENSE), which carries both omp's
notice above and the port's own copyright line.

| | |
|---|---|
| omp (upstream source of the logic) | https://github.com/can1357/oh-my-pi |
| pi (the host agent) | https://github.com/badlogic/pi-mono |
| Anthropic Messages API | https://docs.anthropic.com/en/api/messages |
| Anthropic Usage Policy | https://www.anthropic.com/legal/aup |
| Anthropic Consumer Terms | https://www.anthropic.com/legal/consumer-terms |

*Not an official Anthropic or pi project. Use at your own risk.*
