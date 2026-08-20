# WORKLOG

## 2026-07-06 — Initial build (complete)

Built the full app in one pass:

- Next.js 16 (App Router, TS, Tailwind v4 present but UI is hand-rolled CSS),
  port **4141**.
- `lib/store.ts` — JSON store at `data/accounts.json`, serialized mutations,
  capped activity log.
- `lib/oauth.ts` — token refresh against `console.anthropic.com/v1/oauth/token`
  (Claude Code client id, in-flight de-dupe, persists rotated refresh token),
  Keychain/credentials-file import, profile-email lookup.
- `app/[...path]/route.ts` — catch-all proxy to api.anthropic.com; buffers
  request body for replay, injects Bearer token, streams responses, on 429
  marks `rateLimitedUntil` (from `anthropic-ratelimit-unified-reset` /
  `retry-after`) and auto-fails-over + retries if enabled.
- Management API: `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/[id]`,
  `PATCH /api/settings`. Tokens never sent to the client (only a 6-char tail).
- Dashboard `app/page.tsx` — terminal/phosphor aesthetic (Silkscreen + IBM
  Plex Mono), account cards w/ LIVE/STANDBY/LIMITED states, one-click switch,
  import (keychain or pasted JSON), failover toggle, setup snippet, log.

Verified: `npm run build` clean; live smoke test — keychain import resolved
real account (email + max plan), `GET /v1/models` 200 via proxy, non-stream
`/v1/messages` returned "RELAY OK", SSE streaming passed through, request
stats update. Server left running via `npm run start`.

### Next / ideas
- Optional: auto-switch back when the limited account's window resets.
- Optional: menu-bar helper or `launchd` plist to keep the relay alive.
- Failover retry only triggers on 429 before the stream starts (fine for
  Claude Code, whose limit errors are immediate).

## 2026-07-14 — CLIProxyAPI gateway for non-Claude models (complete)

Added routing so alternate models (gpt-5.6-*, gemini-*, grok-*, …) work
through the relay, powering the `claudex` alias (`claude --model gpt-5.6-sol`).

- `app/[...path]/route.ts` — parses the buffered request body for `model`;
  when it isn't `claude-*`, forwards to a local **CLIProxyAPI** instance
  (`CLIPROXY_BASE_URL`, default `http://127.0.0.1:8317`) with `x-api-key:
  CLIPROXY_API_KEY`, bypassing the Anthropic account/token/failover/usage
  machinery. Claude models are unchanged (Anthropic + account switching).
  Refactored shared header copy into `forwardableHeaders`/`relayResponse`.
- `.env.local` (gitignored) — `CLIPROXY_BASE_URL` + `CLIPROXY_API_KEY`.
- CLIProxyAPI installed via Homebrew (`brew services start cliproxyapi`),
  config at `/opt/homebrew/etc/cliproxyapi.conf` (bound to 127.0.0.1:8317,
  single api-key). GPT models served via `cliproxyapi -codex-login` OAuth
  (ChatGPT Pro account, creds in `~/.cli-proxy-api/`).

Verified: `npm run build` clean; direct `POST :8317/v1/messages` with
gpt-5.6-sol → 200; end-to-end via relay `POST :4141/v1/messages`
gpt-5.6-sol → 200 ("E2E GPT OK"); claude path (`GET :4141/v1/models`) still
200 through the Anthropic account. Relay restarted to pick up the change.

### Operational notes
- `claudex` requires the cliproxyapi service running (`brew services`) AND the
  relay running on 4141. If gpt models 5xx, check `brew services list` and the
  Codex token in `~/.cli-proxy-api/`.
- GET `/v1/models` has no body, so it always goes to Anthropic (not the
  gateway). Claude Code tolerates its `--model` not appearing there; revisit
  with a merged model list if that ever changes.

## 2026-08-05 — Fix `invalid_grant` refresh-token rotation race (complete)

**Symptom:** every ~8h the relay 502'd with `token refresh failed: 400
{"error":"invalid_grant","error_description":"Refresh token not found or
invalid"}`, retrying ~10× and only recovering after a manual re-import.

**Root cause:** Anthropic rotates the refresh token on every use, and the proxy
kept a *private copy* of credentials shared with the Claude Code install on this
machine. Claude Code refreshes directly against `console.anthropic.com` — that
traffic never passes through the proxy — so whichever side refreshed second got
`invalid_grant`. The in-flight de-dupe `Map` in `lib/oauth.ts` only guarded
concurrent refreshes *within* the proxy process; it could not see Claude Code.

**Why it started 08-04:** the log shows `switch "Secondary" → "Primary"`
at 20:08:05 and the first failure 30s later. `Secondary` is not this
machine's login (sole owner of its refresh token → no contention). `Primary`
*is*, which created the shared-credential race. Failures then recurred at each
8h access-token boundary (`REFRESH_MARGIN` fires 5 min early).

**Fix — local credential store becomes the source of truth for the linked
account** (`lib/oauth.ts` rewritten around a `LocalSnapshot`):
- `Account.localKeychain` marks the account Claude Code is logged in as. Set on
  import from `source: "local"`; also backfilled lazily by token match.
- On refresh for a linked account: read the Keychain first and **adopt** a newer
  token instead of refreshing (the common case — zero network calls).
- If a refresh is still needed, use the *Keychain's* refresh token, not our copy.
- After a successful refresh, **write the rotation back** to the Keychain (or
  `~/.claude/.credentials.json`), preserving every sibling key (`mcpOAuth`,
  `rateLimitTier`, `refreshTokenExpiresAt`, …) so Claude Code's own login keeps
  working. Write failure is surfaced in the activity log, not swallowed.
- On `invalid_grant` we re-read and retry once (`RefreshError.invalidGrant`),
  so a lost race self-heals instead of storming the log.
- Access tokens stay valid after rotation, so the Keychain is only consulted on
  the refresh path — the hot path is unchanged.

**Verified:**
- Offline reproduction (stale store + fresh Keychain): pre-fix code emitted the
  exact production error; post-fix adopts the Keychain token with **0 network
  calls**. Test restores the store afterwards.
- Keychain write-back exercised against a throwaway service: tokens updated,
  all sibling keys preserved, `-U` updates in place (no duplicate item).
- `npx tsc --noEmit` clean; `next build` clean (run on an isolated copy — see
  note below).
- End-to-end through the relay: `POST /v1/messages` → "RELAY OK",
  `GET /v1/models` → 200.

### Operational notes
- **The relay runs `next dev` (pid varies), not `next start`** — despite the
  2026-07-06 entry. HMR picks changes up live. Running `next build` in the
  project dir overwrites the `.next` the dev server is serving from and can
  drop in-flight requests, so production builds were verified on an rsync'd
  copy in a scratch dir (Turbopack rejects a symlinked `node_modules` — it must
  be a real copy; APFS `cp -Rc` makes that cheap).
- Smoke-testing with plain `curl` gives a misleading **429 `rate_limit_error`
  with no `anthropic-ratelimit-unified-*` headers** — an OAuth token used
  without Claude Code's identity fails that way even at 15% quota. Include
  `anthropic-beta: oauth-2025-04-20,claude-code-20250219`, a `claude-cli`
  user-agent, and the Claude Code system prompt. Such a 429 briefly writes a
  bogus `"hit its limit"` log line; it self-clears on the next real request via
  the `unified-status: allowed` path.
- `autoFailover` is currently **off**, and failover only triggers on 429
  (`app/[...path]/route.ts`) — a refresh failure surfaces as 502 and does not
  fail over. Left as-is (the root cause is fixed); revisit if a *second*
  account ever needs to cover a token failure.

## 2026-08-21 — Pre-publication credential audit + repo recreation

Audited the repo for committed secrets ahead of a possible public release.
Result: **no credentials were ever committed.** Verified by extracting all 23
secret-length strings from `.env.local`, `data/accounts.json` and
`data/last-429.json`, then grepping every blob in every commit for each one.
Zero token hits. `/data` and `.env*` are correctly gitignored and never
appeared in the history at all. A pattern sweep (`sk-`, `sk-ant-`, `ghp_`,
`github_pat_`, `AKIA`, PEM, JWT, `Bearer`) matched only the truncated
placeholder in `app/page.tsx`.

One real finding: a colleague's work email appeared twice in the 08-05 entry
above. Redacted to `"Secondary"` and amended out of the tip commit.

**Why the repo's creation date changed:** force-pushing unlinks a commit but
does not garbage-collect it, and GitHub kept serving the pre-redaction SHA
`5379bc8` by direct API lookup. Since the repo had no stars, forks, issues or
PRs, the cheapest guaranteed fix was to delete and recreate it (private) and
re-push. `5379bc8` now 404s; all four commit SHAs are unchanged. Deleting
needed a one-time `gh auth refresh -s delete_repo`.

**Decision: the repo is public** (shared with the team), but the app itself is
localhost-only, so the missing auth on the dashboard and `/api/*` routes is
accepted rather than fixed. README now spells that constraint out for anyone
who clones it. Note that the activity log
served to the dashboard contains account names and emails, so if this is ever
exposed beyond localhost that becomes a real leak, not a theoretical one.
