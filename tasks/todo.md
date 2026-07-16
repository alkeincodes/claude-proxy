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
