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
