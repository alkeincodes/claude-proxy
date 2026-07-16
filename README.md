# CLAUDE//RELAY

A local proxy + dashboard that lets your Claude Code sessions switch between
multiple Claude accounts with one click — no `/login`, no restarting sessions.

## How it works

Your sessions talk to this app instead of `api.anthropic.com`
(`ANTHROPIC_BASE_URL=http://localhost:4141`). The relay strips whatever auth
Claude Code sends and injects the OAuth token of whichever account is
**active** in the dashboard. Switching accounts changes the token for the very
next request, so every session — including ones already running — flips
instantly.

It also keeps each account's token fresh (rotating refresh tokens are
persisted), and can **auto-failover**: when the live account gets a 429, the
relay marks it limited, switches to the other account, and transparently
retries the request.

## Alternative models (CLIProxyAPI)

Requests whose `model` is **not** `claude-*` (e.g. `gpt-5.6-sol`, `gemini-*`,
`grok-*`) are forwarded to a local [CLIProxyAPI](https://127.0.0.1:8317)
instance instead of Anthropic. It exposes an Anthropic-compatible
`/v1/messages` endpoint and serves those models through OAuth'd
GPT/Gemini/etc subscriptions. Configure it with:

- `CLIPROXY_BASE_URL` — gateway origin (default `http://127.0.0.1:8317`).
- `CLIPROXY_API_KEY` — sent as `x-api-key` when set (put it in `.env.local`).

Claude models are untouched: they still go to Anthropic with account
switching, 429 failover, and usage tracking. The gateway path skips all of
that — no account, OAuth token, failover, or usage tracking.

## Setup

**Prerequisites:** Node.js 24+ and Claude Code installed and signed in.

```bash
git clone git@github.com:alkeincodes/claude-proxy.git
cd claude-proxy
npm install
npm run build
npm run start   # serves dashboard + proxy on http://localhost:4141
```

> Use `npm run dev` instead of `build`/`start` for hot-reload while hacking on the relay.

**Optional — alternative models.** Only needed if you want to route non-Claude
models (`gpt-*`, `gemini-*`, `grok-*`) through a local CLIProxyAPI. Create
`.env.local`:

```bash
CLIPROXY_BASE_URL=http://127.0.0.1:8317
CLIPROXY_API_KEY=your-cliproxy-key   # sent as x-api-key when set
```

Then:

1. Open http://localhost:4141 and click **import current login** — this reads
   the account Claude Code is signed into (macOS Keychain, falling back to
   `~/.claude/.credentials.json`).
2. In any terminal: `claude` → `/logout` → `/login` with your second account,
   then import again. (You can `/login` back to your preferred one after —
   the relay keeps its own copies.)
3. Point sessions at the relay — in `~/.claude/settings.json`:

   ```json
   { "env": { "ANTHROPIC_BASE_URL": "http://localhost:4141" } }
   ```

   Sessions started after this change go through the relay; switch accounts
   from the dashboard anytime.

## Notes

- Tokens live in `data/accounts.json` (gitignored, plaintext — local use only).
- The relay binds to localhost via Next's default; don't expose it.
- If the relay is down, sessions pointed at it fail — remove the env override
  or restart the app.
- Re-importing an account (matched by email) updates it in place.
