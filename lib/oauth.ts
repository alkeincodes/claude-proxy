import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { addLog, mutateStore } from "./store";
import type { Account } from "./store";

const execFileAsync = promisify(execFile);

/** Claude Code's public OAuth client id. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");

/** Refresh this many ms before the token actually expires. */
const REFRESH_MARGIN = 5 * 60 * 1000;

export interface RawOauthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * The local credentials exactly as stored, so a write-back can update the
 * token fields without dropping sibling keys (`mcpOAuth`, `rateLimitTier`,
 * `refreshTokenExpiresAt`, …) that Claude Code depends on.
 */
interface LocalSnapshot {
  creds: RawOauthCredentials;
  raw: Record<string, unknown>;
  /** true when the OAuth fields live under a `claudeAiOauth` wrapper key */
  wrapped: boolean;
  source: "keychain" | "file";
  keychainAccount?: string;
}

// De-dupe concurrent refreshes per account (several sessions can hit the
// proxy at once; Anthropic rotates refresh tokens, so a double refresh
// would invalidate one of them).
const g = globalThis as unknown as {
  __claudeProxyRefresh?: Map<string, Promise<string>>;
};
if (!g.__claudeProxyRefresh) g.__claudeProxyRefresh = new Map();
const inflight = g.__claudeProxyRefresh;

function isFresh(expiresAt: number): boolean {
  return expiresAt - REFRESH_MARGIN > Date.now();
}

/**
 * Returns a valid access token for the account, refreshing (and persisting
 * the rotated refresh token) if it is close to expiry.
 *
 * Access tokens stay valid until they expire even after the refresh token has
 * been rotated, so the local credential store only needs consulting on the
 * refresh path — the common case never touches the Keychain.
 */
export async function ensureFreshToken(account: Account): Promise<string> {
  if (isFresh(account.expiresAt)) {
    return account.accessToken;
  }
  return refreshToken(account, false);
}

/**
 * Recover after Anthropic rejects an access token that still looks fresh.
 * This happens after `claude /login`: the new login revokes the previous
 * access token, but its local expiry remains hours in the future.
 */
export function refreshRejectedToken(account: Account): Promise<string> {
  return refreshToken(account, true);
}

/** De-dupe both scheduled refreshes and rejected-token recovery. */
async function refreshToken(
  account: Account,
  acceptLocalReplacement: boolean,
): Promise<string> {
  const existing = inflight.get(account.id);
  if (existing) return existing;

  const promise = refreshAccount(account, acceptLocalReplacement);
  inflight.set(account.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(account.id);
  }
}

/**
 * Refresh flow for one account.
 *
 * For the account Claude Code itself is logged in as, the Keychain is shared
 * mutable state: Claude Code refreshes directly against console.anthropic.com
 * (that traffic never passes through this proxy), and each refresh rotates the
 * refresh token. Holding a private copy therefore guarantees an `invalid_grant`
 * the moment either side refreshes. So for linked accounts we (a) adopt a newer
 * Keychain token instead of refreshing, (b) refresh using the Keychain's token
 * rather than ours, (c) write the rotation back so Claude Code stays working,
 * and (d) re-read and retry once if we still lost a race.
 */
async function refreshAccount(
  account: Account,
  acceptLocalReplacement: boolean,
): Promise<string> {
  const snapshot = await readLocalSnapshot();
  const linked = isLinked(account, snapshot);

  if (linked && snapshot) {
    // Claude Code may have already rotated the token out from under us.
    if (
      snapshot.creds.expiresAt > account.expiresAt ||
      (acceptLocalReplacement &&
        snapshot.creds.accessToken !== account.accessToken)
    ) {
      await adoptCredentials(
        account,
        snapshot.creds,
        acceptLocalReplacement
          ? `Re-synced credentials after Anthropic rejected the token for "${account.name}"`
          : `Adopted token refreshed by Claude Code for "${account.name}"`,
      );
      if (isFresh(snapshot.creds.expiresAt)) return snapshot.creds.accessToken;
    }
  }

  const refreshToken =
    linked && snapshot ? snapshot.creds.refreshToken : account.refreshToken;

  try {
    return await performRefresh(account, refreshToken, linked ? snapshot : null);
  } catch (err) {
    // Lost a rotation race: Claude Code refreshed between our read and our
    // POST. Re-read and use whatever it just wrote instead of erroring out.
    if (!linked || !isInvalidGrant(err)) throw err;
    const latest = await readLocalSnapshot();
    if (!latest || latest.creds.refreshToken === refreshToken) throw err;

    await adoptCredentials(
      account,
      latest.creds,
      `Recovered from a token rotation race for "${account.name}"`,
    );
    if (isFresh(latest.creds.expiresAt)) return latest.creds.accessToken;
    return performRefresh(account, latest.creds.refreshToken, latest);
  }
}

/** POST the refresh grant, persist the result, and sync the Keychain. */
async function performRefresh(
  account: Account,
  refreshToken: string,
  snapshot: LocalSnapshot | null,
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = `token refresh failed: ${res.status} ${body.slice(0, 200)}`;
    // Rotation races are recoverable and retried by the caller; don't spam the
    // activity log with them.
    if (!isInvalidGrantBody(body)) {
      await mutateStore((store) => {
        addLog(
          store,
          "error",
          `Token refresh failed for "${account.name}" (${res.status}). Re-import this account.`,
        );
      });
    }
    throw new RefreshError(message, isInvalidGrantBody(body));
  }

  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const next: RawOauthCredentials = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  await mutateStore((store) => {
    const acc = store.accounts.find((a) => a.id === account.id);
    if (!acc) return;
    acc.accessToken = next.accessToken;
    acc.refreshToken = next.refreshToken;
    acc.expiresAt = next.expiresAt;
    addLog(store, "refresh", `Refreshed access token for "${acc.name}"`);
  });

  // Keep Claude Code's own login working: it shares this refresh token, and
  // the copy it holds is now invalid.
  if (snapshot) {
    const ok = await writeLocalSnapshot(snapshot, next);
    if (!ok) {
      await mutateStore((store) => {
        addLog(
          store,
          "error",
          `Refreshed "${account.name}" but could not write the rotated token back to the Keychain — Claude Code may need "claude /login".`,
        );
      });
    }
  }

  return next.accessToken;
}

/** Persist credentials that some other party (Claude Code) already minted. */
async function adoptCredentials(
  account: Account,
  creds: RawOauthCredentials,
  message: string,
): Promise<void> {
  await mutateStore((store) => {
    const acc = store.accounts.find((a) => a.id === account.id);
    if (!acc) return;
    // Exactly one saved account can represent Claude Code's current login.
    for (const other of store.accounts) {
      other.localKeychain = other.id === account.id;
    }
    acc.accessToken = creds.accessToken;
    acc.refreshToken = creds.refreshToken;
    acc.expiresAt = creds.expiresAt;
    addLog(store, "refresh", message);
  });
}

class RefreshError extends Error {
  readonly invalidGrant: boolean;
  constructor(message: string, invalidGrant: boolean) {
    super(message);
    this.invalidGrant = invalidGrant;
  }
}

function isInvalidGrantBody(body: string): boolean {
  return body.includes("invalid_grant");
}

function isInvalidGrant(err: unknown): boolean {
  return err instanceof RefreshError && err.invalidGrant;
}

/**
 * Is this the account Claude Code is logged in as locally? Trusts the stored
 * flag, and backfills it for accounts imported before the flag existed by
 * matching against the live credentials.
 */
function isLinked(account: Account, snapshot: LocalSnapshot | null): boolean {
  if (!snapshot) return false;
  if (account.localKeychain) return true;
  return (
    account.refreshToken === snapshot.creds.refreshToken ||
    account.accessToken === snapshot.creds.accessToken
  );
}

function parseCredentials(raw: string): RawOauthCredentials {
  return toSnapshot(raw, "file").creds;
}

/** Parse a credentials blob, keeping the original shape for write-back. */
function toSnapshot(raw: string, source: LocalSnapshot["source"]): LocalSnapshot {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const wrapped =
    typeof parsed.claudeAiOauth === "object" && parsed.claudeAiOauth !== null;
  const obj = (
    wrapped ? parsed.claudeAiOauth : parsed
  ) as Partial<RawOauthCredentials>;
  if (!obj.accessToken || !obj.refreshToken || !obj.expiresAt) {
    throw new Error(
      "Credentials JSON must contain accessToken, refreshToken and expiresAt (Claude Code keychain format).",
    );
  }
  return {
    creds: {
      accessToken: obj.accessToken,
      refreshToken: obj.refreshToken,
      expiresAt: obj.expiresAt,
      scopes: obj.scopes ?? [],
      subscriptionType: obj.subscriptionType,
    },
    raw: parsed,
    wrapped,
    source,
  };
}

/** The Keychain item is keyed by account name; read it rather than assume. */
async function keychainAccountName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
    ]);
    const match = stdout.match(/"acct"<blob>="([^"]*)"/);
    if (match?.[1]) return match[1];
  } catch {
    // fall through to the current user
  }
  return os.userInfo().username;
}

/** Non-throwing read of the local Claude Code credentials, with write-back info. */
async function readLocalSnapshot(): Promise<LocalSnapshot | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const snapshot = toSnapshot(stdout.trim(), "keychain");
      snapshot.keychainAccount = await keychainAccountName();
      return snapshot;
    } catch {
      // fall through to the credentials file
    }
  }
  try {
    const raw = await fs.readFile(CREDENTIALS_FILE, "utf8");
    return toSnapshot(raw, "file");
  } catch {
    return null;
  }
}

/**
 * Write rotated tokens back to wherever they came from, preserving every other
 * key in the blob. Returns false if the write failed — the caller surfaces that
 * rather than silently leaving Claude Code with a dead refresh token.
 */
async function writeLocalSnapshot(
  snapshot: LocalSnapshot,
  creds: RawOauthCredentials,
): Promise<boolean> {
  const raw = structuredClone(snapshot.raw);
  const target = (
    snapshot.wrapped ? raw.claudeAiOauth : raw
  ) as Record<string, unknown>;
  target.accessToken = creds.accessToken;
  target.refreshToken = creds.refreshToken;
  target.expiresAt = creds.expiresAt;
  const serialized = JSON.stringify(raw);

  try {
    if (snapshot.source === "keychain") {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        snapshot.keychainAccount ?? os.userInfo().username,
        "-w",
        serialized,
      ]);
    } else {
      await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
      await fs.writeFile(CREDENTIALS_FILE, serialized, { mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

/** Best-effort account email lookup; returns null if the endpoint changes. */
export async function fetchProfileEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      account?: { email?: string; email_address?: string };
    };
    return json.account?.email ?? json.account?.email_address ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the credentials of whoever is currently logged in to Claude Code on
 * this machine — macOS Keychain first, then ~/.claude/.credentials.json.
 */
export async function readLocalCredentials(): Promise<RawOauthCredentials> {
  const snapshot = await readLocalSnapshot();
  if (!snapshot) {
    throw new Error(
      "Could not read Claude Code credentials from the macOS Keychain or ~/.claude/.credentials.json. Make sure you are logged in with `claude /login`.",
    );
  }
  return snapshot.creds;
}

export function parsePastedCredentials(raw: string): RawOauthCredentials {
  return parseCredentials(raw);
}
