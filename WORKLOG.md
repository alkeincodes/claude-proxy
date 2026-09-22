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

## 2026-09-23 Root cause of the repeated Claude Code logouts (investigated, not yet fixed)

**Symptom:** `Login expired · Please run /login` and `Not logged in · Please run
/login`, 5 to 13 times a week since at least 08-06, with about 30 successful
`/login`s between 08-18 and 09-22. The 08-05 fix above did not stop it.

**How Claude Code 2.1.280 manages the token** (read from the embedded source
in the binary, not docs):
- Refreshes are serialized by `~/.claude/.oauth_refresh.lock` (proper-lockfile,
  stale 60s). Every storage write is a read-modify-write under a second lock,
  `~/.claude/.storage-write`, and saves are compare-and-swap.
- It re-reads the Keychain before the lock, inside it, and again after a
  failure. Two Claude Code processes cannot collide.
- On `invalid_grant` it tombstones the Keychain item: accessToken and
  refreshToken become `""`, expiresAt `0`. It only does this when the stored
  refresh token is still the one that failed. Every process sharing the item
  then shows "Login expired".
- It refreshes 5 minutes before expiresAt, and posts `scope` every time.

Under that protocol a tombstone should only happen when the refresh-token
family genuinely expires (about 4 weeks here). This machine sees it weekly.

**Root cause:** the relay is a second refresher of the same token that ignores
that protocol. On this machine it is the only one: orca and hermes-agent are
not running, CLIProxyAPI holds only a Codex login, and there is one Keychain
item with no `CLAUDE_CONFIG_DIR` overrides. Specifically, `lib/oauth.ts`:
1. takes neither lock, so Claude Code's serialization does not cover it;
2. uses the same 5-minute margin on the same expiresAt, so both sides decide
   to refresh in the same window by design;
3. writes the whole blob back from a snapshot taken before its POST, outside
   `.storage-write`, which can clobber a concurrent Claude Code write;
4. passes the credentials on argv (`security ... -w <json>`) with no timeout.

When the relay has already POSTed `RT_n` and has not written `RT_n+1` back
yet, a Claude Code refresh posts `RT_n`, gets `invalid_grant`, still sees
`RT_n` stored, and tombstones the item.

**Why it then stays broken for hours:** a tombstoned Keychain fails the
relay's `toSnapshot` validation, so `readLocalSnapshot` falls back to
`~/.claude/.credentials.json`. On this machine that file is from 08-13, and its
refresh-token family expired 09-11. The relay trusts it over its own store.
Offline repro against the real `lib/oauth.ts` (fake `security` on PATH, temp
HOME, stubbed fetch, relay holding the only valid token):
- `ensureFreshToken` POSTs the file's dead token, fails, and never tries its own;
- `refreshRejectedToken` (the 401 path) overwrites the relay's valid tokens
  with the dead file credentials;
- neither path writes the Keychain, so the tombstone is never healed.
This matches 09-08: Claude Code "Login expired" at 00:04, then the relay failing
with `invalid_grant` at 00:05 and every hour until the `/login` at 20:55.

**Not pinned down:**
- Which exact interleaving started each incident. Claude Code keeps no debug
  logs here, and the relay's 80-entry log is full of 429 noise.
- `Not logged in` (no token, no tombstone). From the code it is either a
  Keychain read that fails with no cached copy, or a 401 body mentioning
  "x-api-key". The login keychain never auto-locks, so it is not that.

**Also found:**
- The relay listens on every interface: `next dev` logs
  `Network: http://192.168.68.110:4141`. The no-auth dashboard, and the proxy
  itself (inference on this subscription), are reachable from the LAN. The
  README's localhost claim is wrong.
- 13,473 `EADDRINUSE` failed starts in `~/Library/Logs/claude-proxy/stderr.log`:
  launchd kept retrying while a manual `npm run dev` held the port. It is
  launchd-owned and stable now.
- The relay refreshes against `console.anthropic.com` without `scope`, while
  Claude Code uses `platform.claude.com` with scope.

**Fix direction (not implemented):** make the relay a reader, not a refresher,
for the linked account. Adopt from the Keychain, keep using the current access
token until it actually expires (Claude Code refreshes 5 minutes earlier), and
only refresh after taking `.oauth_refresh.lock` itself. Never prefer
`.credentials.json` over the relay's own token, and heal a tombstone when the
relay holds a valid one. Bind to 127.0.0.1.
