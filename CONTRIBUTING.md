# Contributing

How to develop, test and release `pi-sub-anthropic`, for anyone changing the
code in this repository.

## Setup

```bash
git clone git@github.com:spksoft/pi-sub-anthropic.git
cd pi-sub-anthropic
npm install          # or: npm run link:dev  — reuse an installed pi's node_modules
pi install "$PWD"    # load this checkout into pi; the path is recorded, nothing is copied
```

`npm run link:dev` symlinks `node_modules` at an installed pi, which is an
alternative to `npm install` for type resolution. Point it at a package
explicitly if auto-detection fails:

```bash
npm run link:dev -- /path/to/@earendil-works/pi-coding-agent
```

`pi remove "$PWD"` unloads it again; `/reload` in a running pi picks up edits.

Everything runs under `node --experimental-strip-types` (Node >= 22.6). There is
**no build step**; do not add one. pi loads the extension with the Node that
runs pi — not necessarily the `node` first on your `PATH` — and that interpreter
must be >= 22.6 or type stripping fails at load.

There are no runtime npm dependencies. The Messages API is spoken directly over
`fetch`.

## Layout

| path | role |
|---|---|
| `index.ts` | entry point: `pi.registerProvider("pi-sub-anthropic", …)` + model catalog |
| `oauth.ts` | OAuth login/refresh (PKCE, callback port 54545) + bootstrap identity |
| `stream.ts` | Messages streaming: headers, token clamp, tool prefixing, SSE parsing, system-prompt relocation |
| `fingerprint.ts` | pinned wire constants, beta profiles, billing header, XXH64, `cch` patch |
| `wire-test.ts` | 55 assertions against a mock Anthropic HTTP server; no credentials, no network |
| `compare-bun.ts` / `verify-xxhash.ts` | XXH64 conformance (vs bun native / canonical vectors) |
| `diagnostics/*.ts` | one-off probes that need a **live** credential; not part of `npm test` |
| `scripts/link-dev.mjs` | symlinks `node_modules` at an installed pi |

## Tests

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

## Releasing

The package is live at https://www.npmjs.com/package/pi-sub-anthropic and listed
at https://pi.dev/packages/pi-sub-anthropic. That gallery is an index of npm, not
a submission queue: the `pi-package` keyword in `package.json` is what put it
there, and it renders `repository` as its repo link with
`pi install npm:pi-sub-anthropic` as its install command.

Publishing is a GitHub Actions job, not a laptop command:
`.github/workflows/publish.yml` runs on `release: [published]`.

Credential setup — a **granular** access token with publish rights. Classic
tokens were revoked registry-wide on 9 Dec 2025, and granular write tokens
expire after at most 90 days, so this credential is temporary by design:

```bash
npm login                                   # 2-hour session, only to authorise the next command
npm token create --name pi-sub-anthropic-ci \
  --packages pi-sub-anthropic --packages-and-scopes-permission read-write \
  --orgs-permission no-access --expires 90 --bypass-2fa
gh secret set NPM_TOKEN                     # paste the token
```

Scope it to the single package — `--packages-all` was only needed for the first
publish, when the package did not exist to be named. `--bypass-2fa` is needed
only if the account or package enforces 2FA on publish, and it is on a
deprecation clock (see below).

Then every release is a single command — **the tag decides the published
version**, so `package.json` never has to be bumped by hand:

```bash
gh release create v1.0.0 --generate-notes
```

The workflow, in order: pins Node 24 and upgrades npm (OIDC needs >= 11.5.1),
derives the version from the tag (`v` optional) and rejects anything that is not
semver, writes it into `package.json` and the lockfile with `npm version
--no-git-tag-version` (runner-only — nothing is committed or tagged back),
`npm ci`, `npm run typecheck`, `npm run test`, `npm run test:xxhash`, diffs the
packed file list against the expected 7 entries, then publishes with
`--provenance`.

The dist-tag is `latest` only for a plain release of a plain version. A release
marked *pre-release*, **or** a tag carrying a semver prerelease suffix
(`v1.0.0-rc.1`), goes to `next` — so a forgotten checkbox cannot move `latest`
to a release candidate.

`publishConfig.access` is `public` in `package.json` and must stay that way:
with `--provenance`, npm refuses a **new** package unless access is explicitly
public (`EUSAGE: Can't generate provenance for new or private package, you must
set 'access' to public`). Unscoped packages default to public only once they
exist, which is exactly the case a first release does not satisfy.

A release-triggered run uses the workflow and `package.json` **from the tagged
commit**, not from `main`. Fixing a release failure therefore means committing
the fix and cutting a new tag — re-running the failed job replays the old tree.

The file-set gate exists because `files` restricts the tarball to the four
runtime sources plus `README.md`/`LICENSE`, and the `diagnostics/*.ts` probes
read `~/.pi/agent/auth.json` — they must never ship. To reproduce the gate, and
the runtime check the workflow does not do, locally:

```bash
npm pack --dry-run                                      # expect exactly 7 entries
npm pack && tar xzf pi-sub-anthropic-*.tgz -C /tmp
pi -ne -e /tmp/package --list-models pi-sub-anthropic   # 13 models, settings untouched
```

Do not parse `npm pack --json` with a fixed shape: npm <= 11 emits an array of
package objects, npm >= 12 emits an object keyed by package name. The workflow
normalises both; a `jq '.[0]…'` one-liner breaks the moment CI upgrades npm.

### Move to trusted publishing — now actionable

Token publishing is on a deprecation clock. Since 31 Jul 2026 a bypass-2FA
granular token can no longer perform account, org or package **management** —
including configuring trusted publishing itself. npm is targeting **January
2027** for bypass-2FA tokens to lose *direct publish* as well, leaving them able
only to read private packages and to `npm stage publish` for a maintainer to
approve with 2FA.

The first publish had to be token-based because trusted publishing and staged
publishing both require the package to already exist. It exists now, so:

1. Configure the trusted publisher **interactively** (npmjs.com → package
   Settings → Trusted publishing → GitHub Actions, org/user `spksoft`, repo
   `pi-sub-anthropic`, workflow filename `publish.yml`). The CI token cannot do
   this, by design.
2. Cut one release to confirm OIDC works, then delete the `NPM_TOKEN` secret.
   The workflow already grants `id-token: write`, the npm CLI prefers OIDC over
   `NODE_AUTH_TOKEN`, and provenance becomes automatic for a public repo
   publishing a public package, so `--provenance` turns into a no-op rather than
   a requirement.
3. Optional hardening: package Settings → Publishing access → *Require
   two-factor authentication and disallow tokens*, and/or a stage-only trusted
   publisher so each CI publish waits for a 2FA approval.

Two exact-match traps: `repository.url` in `package.json` must match the GitHub
repo (hence the `git+https://github.com/spksoft/pi-sub-anthropic.git` form, not
the SSH one), and the configured workflow filename is case-sensitive including
the `.yml`. npm does not validate a trusted-publisher configuration when you save
it — a mismatch only surfaces as `ENEEDAUTH` on the next publish.

One more packaging trap, measured against the published 0.1.4 tarball: npm and
the pi gallery rewrite **relative** links in the rendered README to
`cdn.jsdelivr.net/npm/pi-sub-anthropic@<version>/<path>`, which only resolves
for files inside the tarball. `LICENSE` and `README.md` return 200 there;
`CONTRIBUTING.md` and `docs/internals.md` returned 404 because `files` excludes
them. README therefore links to those two with absolute
`github.com/spksoft/pi-sub-anthropic/blob/main/...` URLs. Keep it that way, or
ship the docs in `files` and update the 7-entry gate.

## Versioning

The release tag is the source of truth. `package.json`'s committed version is
only what a local `npm pack` stamps; the workflow overwrites it from the tag
before publishing, so the two never need to be kept in sync manually.

| release tag | pre-release flag | published as |
|---|---|---|
| `v1.0.0` | off | `1.0.0`, dist-tag `latest` |
| `1.0.0` (no prefix) | off | `1.0.0`, dist-tag `latest` |
| `v1.0.0-rc.1` | off | `1.0.0-rc.1`, dist-tag `next` |
| `v1.0.0` | on | `1.0.0`, dist-tag `next` |
| `v1.0`, `release-1.0.0` | — | rejected, nothing published |

What the version number is actually promising here — the consumable surface is
not a TypeScript API (nothing imports this package; pi loads `index.ts`), it is
the provider id, the env var names, the model ids and the `auth.json`
credential key:

| bump | change |
|---|---|
| **major** | provider id or env var rename, credential-key change, dropping a model id, raising the pi/Node floor |
| **minor** | re-syncing the pinned omp fingerprint (the wire changes), adding models, adding an env var, new OAuth behaviour |
| **patch** | fixes with byte-identical wire output, docs, tests |

Staying on `0.x` is deliberate. The identity this package exposes was renamed
once already (`omp-anthropic` → `pi-sub-anthropic`), and the fingerprint it
depends on is owned by Anthropic and transcribed from omp — neither is under
this repo's control, so churn is expected rather than exceptional. `1.0.0` is
worth cutting once the fingerprint has survived one upstream re-sync without a
user-visible rename.

Nothing is lost by waiting: pi records either `npm:pi-sub-anthropic` (tracks
latest) or `npm:pi-sub-anthropic@<exact>` (pinned, skipped by `pi update`), so
npm's caret rules — the one place where `0.x` and `1.x` genuinely differ — never
apply. The choice is signalling only, and a premature `1.0.0` just means
spending `2.0.0` on the next rename.

```bash
gh release create v0.2.0 --generate-notes                 # fingerprint re-sync, new models
gh release create v1.0.0 --generate-notes                 # renamed provider id or env vars
gh release create v1.0.0-rc.1 --prerelease --generate-notes   # -> next, opt-in only
```

---

Design rationale and measurements live in
[docs/internals.md](docs/internals.md); user-facing installation and
configuration live in [README.md](README.md).

[AGENTS.md](AGENTS.md) carries the same hard rules and wire-behaviour guidance
for coding agents.
