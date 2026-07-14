"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicAccount } from "@/lib/serialize";
import type { LogEntry } from "@/lib/store";

interface StoreView {
  activeAccountId: string | null;
  settings: { autoFailover: boolean };
  accounts: PublicAccount[];
  log: LogEntry[];
}

function timeAgo(ts: number | null): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function timeUntil(ts: number): string {
  const s = Math.max(0, Math.floor((ts - Date.now()) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Meter({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number | null;
  resetsAt: number | null;
}) {
  const pct = utilization == null ? null : Math.min(100, Math.round(utilization * 100));
  const heat = pct == null ? "" : pct >= 90 ? "hot" : pct >= 70 ? "warn" : "";
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <span className="meter">
        {pct != null && <span className={`meter-fill ${heat}`} style={{ width: `${pct}%` }} />}
      </span>
      <span className="meter-value">
        {pct != null ? `${pct}%` : "—"}
        {resetsAt ? ` · resets ${clock(resetsAt)}` : ""}
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn copy"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function Dashboard() {
  const [store, setStore] = useState<StoreView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importName, setImportName] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [, tick] = useState(0);
  const [origin, setOrigin] = useState("http://localhost:4141");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      if (res.ok) setStore((await res.json()) as StoreView);
    } catch {
      /* server restarting; keep last view */
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    refresh();
    const poll = setInterval(refresh, 4000);
    const clock = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);

  const call = useCallback(async (input: string, init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(input, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const json = await res.json();
      if (!res.ok) {
        setError(String(json.error ?? `request failed (${res.status})`));
        return false;
      }
      setStore(json as StoreView);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const importLocal = () =>
    call("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ source: "local", name: importName }),
    }).then((ok) => ok && setImportName(""));

  const importPaste = () =>
    call("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ source: "paste", credentials: pasted, name: importName }),
    }).then((ok) => {
      if (ok) {
        setPasted("");
        setImportName("");
        setShowPaste(false);
      }
    });

  const settingsSnippet = useMemo(
    () => JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin } }, null, 2),
    [origin],
  );

  const activeAccount = store?.accounts.find((a) => a.id === store.activeAccountId);

  return (
    <main className="wrap">
      <header className="masthead">
        <h1 className="logo">
          CLAUDE<span className="slash">//</span>RELAY
          <span className="cursor" />
        </h1>
        <span className="tagline">local credential relay for claude code</span>
      </header>

      <div className="statusbar">
        <span className="chip">
          <span className="dot" /> relay online
        </span>
        <span className="chip">{origin} → api.anthropic.com</span>
        <span className="chip">
          serving:{" "}
          <strong style={{ color: "var(--green)" }}>
            {activeAccount ? activeAccount.name : "— none —"}
          </strong>
        </span>
      </div>

      <h2 className="section-label">ACCOUNTS</h2>

      {store && store.accounts.length === 0 && (
        <div className="empty">
          No accounts yet. Import the account you&apos;re currently logged in
          with below, then <code>/logout</code> + <code>/login</code> to your
          second account in any terminal and import again.
        </div>
      )}

      <div className="cards">
        {store?.accounts.map((a) => {
          const isActive = a.id === store.activeAccountId;
          const isLimited = !!a.rateLimitedUntil && a.rateLimitedUntil > Date.now();
          return (
            <article
              key={a.id}
              className={`card ${isActive ? "active" : ""} ${isLimited ? "limited" : ""}`}
            >
              <div className="card-top">
                <div>
                  <h3 className="acct-name">{a.name}</h3>
                  {a.email && <div className="acct-email">{a.email}</div>}
                </div>
                {isActive ? (
                  <span className="badge live">● LIVE</span>
                ) : isLimited ? (
                  <span className="badge limited">LIMITED</span>
                ) : (
                  <span className="badge">STANDBY</span>
                )}
              </div>

              <dl className="acct-meta">
                <dt>plan</dt>
                <dd>{a.subscriptionType ?? "unknown"}</dd>
                <dt>token</dt>
                <dd>…{a.tokenTail}</dd>
                <dt>requests</dt>
                <dd>{a.requestCount}</dd>
                <dt>last used</dt>
                <dd>{timeAgo(a.lastUsedAt)}</dd>
                {isLimited && a.rateLimitedUntil && (
                  <>
                    <dt>limit resets</dt>
                    <dd className="warn">
                      in {a.rateLimitEstimated ? "~" : ""}
                      {timeUntil(a.rateLimitedUntil)}
                      {a.rateLimitEstimated ? " (estimate)" : ""}
                    </dd>
                  </>
                )}
              </dl>

              {a.usage && (
                <div className="meters">
                  <Meter
                    label="5h"
                    utilization={a.usage.fiveHour.utilization}
                    resetsAt={a.usage.fiveHour.resetsAt}
                  />
                  <Meter
                    label="7d"
                    utilization={a.usage.sevenDay.utilization}
                    resetsAt={a.usage.sevenDay.resetsAt}
                  />
                </div>
              )}

              <div className="card-actions">
                <button
                  className="btn primary"
                  disabled={busy || isActive}
                  onClick={() =>
                    call(`/api/accounts/${a.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ action: "activate" }),
                    })
                  }
                >
                  {isActive ? "serving traffic" : "switch to this account"}
                </button>
                <button
                  className="btn ghost"
                  disabled={busy}
                  title="Remove account"
                  onClick={() => {
                    if (confirm(`Remove "${a.name}" from the relay?`)) {
                      call(`/api/accounts/${a.id}`, { method: "DELETE" });
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <h2 className="section-label">IMPORT ACCOUNT</h2>
      <div className="panel">
        <div className="import-row">
          <input
            className="input"
            placeholder="label (e.g. Personal Max)"
            value={importName}
            onChange={(e) => setImportName(e.target.value)}
          />
          <button className="btn primary" disabled={busy} onClick={importLocal}>
            import current login
          </button>
          <button className="btn" onClick={() => setShowPaste((v) => !v)}>
            {showPaste ? "hide paste" : "paste JSON instead"}
          </button>
        </div>
        {showPaste && (
          <div style={{ marginTop: 12 }}>
            <textarea
              className="textarea"
              placeholder='{"claudeAiOauth":{"accessToken":"sk-ant-oat01-…","refreshToken":"sk-ant-ort01-…","expiresAt":…}}'
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              className="btn primary"
              style={{ marginTop: 10 }}
              disabled={busy || !pasted.trim()}
              onClick={importPaste}
            >
              import pasted credentials
            </button>
          </div>
        )}
        <p className="hint">
          &ldquo;Import current login&rdquo; grabs whichever account Claude Code
          is signed into on this Mac (Keychain →{" "}
          <code>~/.claude/.credentials.json</code>). Re-importing the same
          account just refreshes its tokens.
        </p>
        {error && <div className="error-line">✗ {error}</div>}
      </div>

      <h2 className="section-label">FAILOVER</h2>
      <div className="panel toggle-row">
        <div>
          <strong>Auto-failover on rate limit</strong>
          <p className="hint" style={{ marginTop: 4 }}>
            When the live account returns 429, the relay switches to the other
            account and retries the request — your sessions never notice.
          </p>
        </div>
        <button
          className={`toggle ${store?.settings.autoFailover ? "on" : ""}`}
          aria-label="toggle auto failover"
          disabled={busy}
          onClick={() =>
            call("/api/settings", {
              method: "PATCH",
              body: JSON.stringify({ autoFailover: !store?.settings.autoFailover }),
            })
          }
        />
      </div>

      <h2 className="section-label">HOOK UP YOUR SESSIONS</h2>
      <div className="panel">
        <ol className="steps">
          <li>
            Import both accounts above (use <code>/logout</code> +{" "}
            <code>/login</code> once to capture the second one).
          </li>
          <li>
            Point Claude Code at the relay — add this to{" "}
            <code>~/.claude/settings.json</code> so every session uses it:
            <div className="snippet">
              {settingsSnippet}
              <CopyButton text={settingsSnippet} />
            </div>
            <p className="hint">
              Or per-terminal only:{" "}
              <code>export ANTHROPIC_BASE_URL={origin}</code>. Sessions already
              pointed at the relay pick up a switch instantly; sessions started
              before this env change need one restart.
            </p>
          </li>
          <li>
            Hit a limit? Click <em>switch</em> here (or let auto-failover do
            it). No <code>/login</code>, no restarts — the very next request
            uses the other account.
          </li>
        </ol>
        <p className="hint">
          ⚠ Keep this app running while sessions point at it (
          <code>npm run start</code>). Tokens are stored locally in{" "}
          <code>data/accounts.json</code>.
        </p>
      </div>

      <h2 className="section-label">ACTIVITY</h2>
      {store && store.log.length > 0 ? (
        <div className="log">
          {store.log.map((entry, i) => (
            <div key={`${entry.at}-${i}`} className="log-line">
              <span className="log-time">
                {new Date(entry.at).toLocaleTimeString()}
              </span>
              <span className={`log-type ${entry.type}`}>{entry.type}</span>
              <span className="log-msg">{entry.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">No activity yet.</div>
      )}
    </main>
  );
}
