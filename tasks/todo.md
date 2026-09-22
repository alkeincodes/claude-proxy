# claude-proxy — account relay for Claude Code

Goal: local web app that proxies Claude Code traffic to api.anthropic.com and
lets the user switch which account's OAuth token is injected — no /login.

- [x] Scaffold Next.js 16 app (port 4141)
- [x] JSON store (`data/accounts.json`) with serialized writes
- [x] OAuth lib: token refresh (rotating refresh tokens, in-flight de-dupe),
      keychain/credentials-file import, profile email lookup
- [x] Catch-all proxy route `app/[...path]/route.ts` — inject Bearer token,
      stream responses, 429 → mark limited + auto-failover retry
- [x] Management API: list/import accounts, activate/delete, settings
- [x] Dashboard UI (terminal/relay aesthetic): cards, switch, import,
      failover toggle, setup instructions, activity log
- [x] Verify: build + smoke test proxy & import end-to-end

## Review

Built and smoke-tested; see WORKLOG.md.

# 2026-09-23 Stop the relay fighting Claude Code over its token

Root cause is in WORKLOG.md (2026-09-23). The relay refreshes Claude Code's
token outside Claude Code's lock, and then trusts a stale credentials file
over its own valid token.

- [x] Tests first, against a fake `security`, temp HOME and stubbed fetch
- [x] Linked account: only adopt from the Keychain until the token is in its
      last minute. Claude Code refreshes at 5 minutes, so it gets there first
- [x] When the relay must refresh: take `~/.claude/.oauth_refresh.lock` and
      `~/.claude.lock` exactly as Claude Code does, then re-read inside
- [x] Keychain writes: `.storage-write` lock, re-read, compare-and-swap on the
      refresh token, merge into the current blob, secret over stdin
- [x] A tombstoned Keychain never sends the relay to `.credentials.json`; it
      refreshes with its own token and heals the Keychain
- [x] 401 recovery never adopts expired credentials
- [x] Send `scope`, use `platform.claude.com`, keep refresh_token_expires_in
- [x] Bind the relay to `::1` (clients connect over IPv6)
- [x] Move the stale `~/.claude/.credentials.json` aside (renamed, not deleted)
- [x] tsc, tests, build on a copy, then swap in and restart the relay

## Review

Shipped and verified live. 13 tests in `test/oauth.test.mts` cover each
production failure; all 9 behavioral ones failed first against the old code.
Found one bug of my own in testing: `security -i` rejects lines over ~4 KB, and
the real blob is ~7 KB hex, so large writes go on argv like Claude Code's.
Measured against a throwaway Keychain item before encoding it in the fake.
First live refresh window after the swap: Claude Code refreshed at 04:56:57,
the relay adopted it, zero relay refreshes, Keychain and relay in sync.
