import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import lockfile from "proper-lockfile";
import { addLog, mutateStore } from "./store";
import type { Account } from "./store";

/** Claude Code's public OAuth client id. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** The endpoint Claude Code itself refreshes against. */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, ".credentials.json");

/** Accounts the relay owns outright refresh this many ms before expiry. */
const REFRESH_MARGIN = 5 * 60 * 1000;
/**
 * Claude Code refreshes its own login 5 minutes before expiry. For that
 * account the relay only steps in during the last minute, so Claude Code
 * gets there first and the relay just adopts what it wrote.
 */
const LINKED_MARGIN = 60 * 1000;
const SECURITY_TIMEOUT = 5000;
/** Longest line `security -i` accepts, per Claude Code. */
const SECURITY_STDIN_LIMIT = 4032;

export interface RawOauthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

interface Refreshed extends RawOauthCredentials {
  refreshTokenExpiresAt?: number;
}

/**
 * Claude Code's credentials exactly as stored. `raw` keeps sibling keys
 * (`mcpOAuth`, `rateLimitTier`, …) so a write-back never drops them.
 */
interface LocalStore {
  source: "keychain" | "file";
  raw: Record<string, unknown>;
  /** true when the OAuth fields live under a `claudeAiOauth` wrapper key */
  wrapped: boolean;
  /** null when Claude Code has tombstoned the login (blank tokens) */
  creds: RawOauthCredentials | null;
}

/** The local store could not be read, which is not the same as empty. */
const READ_FAILED = Symbol("READ_FAILED");
type LocalRead = LocalStore | null | typeof READ_FAILED;

// De-dupe concurrent refreshes per account (several sessions can hit the
// proxy at once; Anthropic rotates refresh tokens, so a double refresh
// would invalidate one of them).
const g = globalThis as unknown as {
  __claudeProxyRefresh?: Map<string, Promise<string>>;
};
if (!g.__claudeProxyRefresh) g.__claudeProxyRefresh = new Map();
const inflight = g.__claudeProxyRefresh;

/**
 * Returns a valid access token for the account, refreshing (and persisting
 * the rotated refresh token) if it is close to expiry.
 *
 * Access tokens stay valid until they expire even after the refresh token has
 * been rotated, so the local credential store only needs consulting near
 * expiry. The common case never touches the Keychain.
 */
export async function ensureFreshToken(account: Account): Promise<string> {
  if (account.expiresAt - REFRESH_MARGIN > Date.now()) {
    return account.accessToken;
  }
  return dedupe(account, false);
}

/**
 * Recover after Anthropic rejects an access token that still looks fresh.
 * This happens after `claude /login`: the new login revokes the previous
 * access token, but its local expiry remains hours in the future.
 */
export function refreshRejectedToken(account: Account): Promise<string> {
  return dedupe(account, true);
}

async function dedupe(account: Account, rejected: boolean): Promise<string> {
  const existing = inflight.get(account.id);
  if (existing) return existing;

  const promise = syncAccount(account, rejected);
  inflight.set(account.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(account.id);
  }
}

/**
 * For the account Claude Code itself is logged in as, the Keychain item is
 * shared state with a protocol: Claude Code serializes refreshes with a
 * lockfile, compare-and-swaps every save, and blanks the tokens ("tombstone")
 * when a refresh is refused. Refreshing outside that protocol is what kept
 * logging Claude Code out, so for this account the relay adopts whatever
 * Claude Code wrote and only refreshes itself under the same locks.
 */
async function syncAccount(account: Account, rejected: boolean): Promise<string> {
  const local = await readLocal();
  if (!isLinked(account, local)) return refreshOwned(account);

  const adopted = await adoptIfNewer(account, local, rejected);
  if (adopted) return adopted;

  // Claude Code refreshes this login 5 minutes early; leave it to Claude Code.
  if (!rejected && account.expiresAt - LINKED_MARGIN > Date.now()) {
    return account.accessToken;
  }
  return refreshLinked(account, rejected);
}

/** An account only the relay holds: refresh with our own copy. */
async function refreshOwned(account: Account): Promise<string> {
  try {
    const next = await requestRefresh(account.refreshToken);
    await persistRefresh(account, next);
    return next.accessToken;
  } catch (err) {
    await logError(`Token refresh failed for "${account.name}". Re-import this account.`);
    throw err;
  }
}

async function refreshLinked(account: Account, rejected: boolean): Promise<string> {
  try {
    return await withRefreshLock(async () => {
      // Claude Code may have refreshed while we waited for the lock.
      const local = await readLocal();
      if (local === READ_FAILED) throw new Error("could not read Claude Code's credentials");
      const adopted = await adoptIfNewer(account, local, rejected);
      if (adopted) return adopted;

      // The stored refresh token is the one Claude Code will use next, so try
      // it first. Ours only differs when an earlier write-back was lost, and
      // then ours may be the only live one left.
      const candidates = [...new Set([local?.creds?.refreshToken, account.refreshToken])].filter(
        (t): t is string => Boolean(t),
      );
      let lastError: unknown;
      for (const refreshToken of candidates) {
        let next: Refreshed;
        try {
          next = await requestRefresh(refreshToken, storedScopes(local));
        } catch (err) {
          if (!isInvalidGrant(err)) throw err;
          lastError = err;
          continue;
        }
        await persistRefresh(account, next);
        if (local && (await saveRefreshed(refreshToken, next)) === "failed") {
          await logError(
            `Refreshed "${account.name}" but could not save the new token for Claude Code. Claude Code may need "claude /login".`,
          );
        }
        return next.accessToken;
      }
      await logError(`The login for "${account.name}" is no longer valid. Run "claude /login".`);
      throw lastError;
    });
  } catch (err) {
    // Claude Code is holding the lock mid-refresh; our token is still usable.
    if ((err as { code?: string }).code === "ELOCKED" && !rejected && account.expiresAt > Date.now()) {
      return account.accessToken;
    }
    throw err;
  }
}

/**
 * Take the credentials Claude Code wrote if they are a different, newer
 * login. After a 401 ours is dead whatever its expiry says, so any different
 * valid login will do. Expired credentials are never adopted.
 */
async function adoptIfNewer(
  account: Account,
  local: LocalRead,
  rejected: boolean,
): Promise<string | null> {
  if (!local || local === READ_FAILED || !local.creds) return null;
  const creds = local.creds;
  if (creds.accessToken === account.accessToken || creds.expiresAt <= Date.now()) return null;
  if (!rejected && creds.expiresAt <= account.expiresAt) return null;

  await adoptCredentials(
    account,
    creds,
    rejected
      ? `Re-synced credentials after Anthropic rejected the token for "${account.name}"`
      : `Adopted token refreshed by Claude Code for "${account.name}"`,
  );
  return creds.expiresAt - LINKED_MARGIN > Date.now() ? creds.accessToken : null;
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

async function persistRefresh(account: Account, next: Refreshed): Promise<void> {
  await mutateStore((store) => {
    const acc = store.accounts.find((a) => a.id === account.id);
    if (!acc) return;
    acc.accessToken = next.accessToken;
    acc.refreshToken = next.refreshToken;
    acc.expiresAt = next.expiresAt;
    addLog(store, "refresh", `Refreshed access token for "${acc.name}"`);
  });
}

async function logError(message: string): Promise<void> {
  await mutateStore((store) => addLog(store, "error", message));
}

/** POST the refresh grant the same way Claude Code does. */
async function requestRefresh(refreshToken: string, scopes?: string[]): Promise<Refreshed> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  };
  if (scopes?.length) body.scope = scopes.join(" ");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RefreshError(
      `token refresh failed: ${res.status} ${text.slice(0, 200)}`,
      text.includes("invalid_grant"),
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: now + json.expires_in * 1000,
    ...(json.refresh_token_expires_in
      ? { refreshTokenExpiresAt: now + json.refresh_token_expires_in * 1000 }
      : {}),
    ...(json.scope ? { scopes: json.scope.split(" ").filter(Boolean) } : {}),
  };
}

class RefreshError extends Error {
  readonly invalidGrant: boolean;
  constructor(message: string, invalidGrant: boolean) {
    super(message);
    this.invalidGrant = invalidGrant;
  }
}

function isInvalidGrant(err: unknown): boolean {
  return err instanceof RefreshError && err.invalidGrant;
}

/**
 * Is this the account Claude Code is logged in as locally? Trusts the stored
 * flag, and backfills it for accounts imported before the flag existed by
 * matching against the live credentials.
 */
function isLinked(account: Account, local: LocalRead): boolean {
  if (account.localKeychain) return true;
  if (!local || local === READ_FAILED || !local.creds) return false;
  return (
    account.refreshToken === local.creds.refreshToken ||
    account.accessToken === local.creds.accessToken
  );
}

function storedScopes(local: LocalRead): string[] | undefined {
  if (!local || local === READ_FAILED) return undefined;
  const scopes = oauthFields(local)?.scopes;
  return Array.isArray(scopes) ? (scopes as string[]) : undefined;
}

// ---------------------------------------------------------------------------
// Claude Code's locks. Same paths and options as Claude Code 2.1.280, so the
// two programs exclude each other.

const LOCK_RETRIES = { retries: 20, minTimeout: 200, maxTimeout: 1000 };

function onCompromised(err: Error): void {
  console.error(`claude-proxy: credential lock compromised: ${err.message}`);
}

/** Claude Code's refresh lock plus its legacy `~/.claude.lock`. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(CLAUDE_DIR, { recursive: true });
  const options = { realpath: false, stale: 60_000, update: 5_000, retries: LOCK_RETRIES, onCompromised };
  const release = await lockfile.lock(CLAUDE_DIR, {
    ...options,
    lockfilePath: path.join(CLAUDE_DIR, ".oauth_refresh.lock"),
  });
  let releaseLegacy: (() => Promise<void>) | null = null;
  try {
    const legacy = `${await fs.realpath(CLAUDE_DIR)}.lock`;
    try {
      releaseLegacy = await lockfile.lock(legacy, { ...options, lockfilePath: legacy });
    } catch (err) {
      // Claude Code carries on without the legacy lock unless it is held.
      if ((err as { code?: string }).code === "ELOCKED") throw err;
    }
    return await fn();
  } finally {
    await releaseLegacy?.().catch(() => {});
    await release().catch(() => {});
  }
}

/**
 * Save refreshed tokens the way Claude Code does: under its storage-write
 * lock, re-reading first, and only if the stored refresh token is still the
 * one we posted or Claude Code's blank tombstone. Anything else means someone
 * wrote since, most likely a fresh `/login`, and theirs wins.
 */
async function saveRefreshed(
  postedRefreshToken: string,
  next: Refreshed,
): Promise<"saved" | "superseded" | "failed"> {
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path.join(CLAUDE_DIR, ".storage-write"), {
      realpath: false,
      stale: 15_000,
      retries: { retries: 10, minTimeout: 100, maxTimeout: 1000 },
      onCompromised,
    });
  } catch {
    return "failed";
  }
  try {
    const current = await readLocal();
    if (current === READ_FAILED) return "failed";
    const fields = current ? oauthFields(current) : null;
    const stored = fields?.refreshToken;
    if (!current || !fields || (stored !== "" && stored !== postedRefreshToken)) {
      return "superseded";
    }
    fields.accessToken = next.accessToken;
    fields.refreshToken = next.refreshToken;
    fields.expiresAt = next.expiresAt;
    if (next.refreshTokenExpiresAt) fields.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
    if (next.scopes) fields.scopes = next.scopes;
    return (await writeLocal(current)) ? "saved" : "failed";
  } finally {
    await release().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Reading and writing Claude Code's credential store.

/** Run `security`, feeding `input` on stdin so secrets never reach argv. */
function runSecurity(args: string[], input = ""): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SECURITY_TIMEOUT);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
    child.stdin.end(input);
  });
}

/**
 * Read the local credentials in Claude Code's order: the Keychain, then
 * `~/.claude/.credentials.json` only when there is no Keychain item at all.
 * A tombstoned Keychain item is a real answer, not a reason to fall back.
 */
async function readLocal(): Promise<LocalRead> {
  if (process.platform === "darwin") {
    try {
      const { code, stdout } = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
      // 44 = errSecItemNotFound; anything else non-zero is a failed read.
      if (code === 0) return { ...parseBlob(stdout.trim()), source: "keychain" };
      if (code !== 44) return READ_FAILED;
    } catch {
      return READ_FAILED;
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(CREDENTIALS_FILE, "utf8");
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? null : READ_FAILED;
  }
  try {
    return { ...parseBlob(raw), source: "file" };
  } catch {
    return READ_FAILED;
  }
}

/** The Keychain item is keyed by account name; read it rather than assume. */
async function keychainAccountName(): Promise<string> {
  try {
    const { code, stdout } = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
    const match = stdout.match(/"acct"<blob>="([^"]*)"/);
    if (code === 0 && match?.[1]) return match[1];
  } catch {
    // fall through to the current user
  }
  return os.userInfo().username;
}

/** Write the blob back where it came from. Returns false if that failed. */
async function writeLocal(local: LocalStore): Promise<boolean> {
  const serialized = JSON.stringify(local.raw);
  try {
    if (local.source === "keychain") {
      const account = await keychainAccountName();
      const hex = Buffer.from(serialized, "utf8").toString("hex");
      const line = `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
      // `security -i` rejects long lines, so like Claude Code, larger blobs
      // (anything carrying MCP tokens) go on argv instead.
      const { code } =
        line.length <= SECURITY_STDIN_LIMIT
          ? await runSecurity(["-i"], line)
          : await runSecurity(["add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICE, "-X", hex]);
      return code === 0;
    }
    await fs.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
    await fs.writeFile(CREDENTIALS_FILE, serialized, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function oauthFields(local: LocalStore): Record<string, unknown> | null {
  const fields = local.wrapped ? local.raw.claudeAiOauth : local.raw;
  return typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : null;
}

/** Parse a credentials blob, keeping the original shape for write-back. */
function parseBlob(raw: string): Omit<LocalStore, "source"> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const wrapped = typeof parsed.claudeAiOauth === "object" && parsed.claudeAiOauth !== null;
  const obj = (wrapped ? parsed.claudeAiOauth : parsed) as Partial<RawOauthCredentials>;
  const creds =
    obj.accessToken && obj.refreshToken && obj.expiresAt
      ? {
          accessToken: obj.accessToken,
          refreshToken: obj.refreshToken,
          expiresAt: obj.expiresAt,
          scopes: obj.scopes ?? [],
          subscriptionType: obj.subscriptionType,
        }
      : null;
  return { raw: parsed, wrapped, creds };
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
 * this machine: the macOS Keychain first, then ~/.claude/.credentials.json.
 */
export async function readLocalCredentials(): Promise<RawOauthCredentials> {
  const local = await readLocal();
  if (local && local !== READ_FAILED && local.creds) return local.creds;
  throw new Error(
    local && local !== READ_FAILED
      ? "Claude Code's login on this machine has expired. Run `claude /login`, then import again."
      : "Could not read Claude Code credentials from the macOS Keychain or ~/.claude/.credentials.json. Make sure you are logged in with `claude /login`.",
  );
}

export function parsePastedCredentials(raw: string): RawOauthCredentials {
  const { creds } = parseBlob(raw);
  if (!creds) {
    throw new Error(
      "Credentials JSON must contain accessToken, refreshToken and expiresAt (Claude Code keychain format).",
    );
  }
  return creds;
}
