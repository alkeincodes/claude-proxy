import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { Account, addLog, mutateStore } from "./store";

const execFileAsync = promisify(execFile);

/** Claude Code's public OAuth client id. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Refresh this many ms before the token actually expires. */
const REFRESH_MARGIN = 5 * 60 * 1000;

export interface RawOauthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

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
 */
export async function ensureFreshToken(account: Account): Promise<string> {
  if (account.expiresAt - REFRESH_MARGIN > Date.now()) {
    return account.accessToken;
  }
  const existing = inflight.get(account.id);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await mutateStore((store) => {
        addLog(
          store,
          "error",
          `Token refresh failed for "${account.name}" (${res.status}). Re-import this account.`,
        );
      });
      throw new Error(`token refresh failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const accessToken = json.access_token;
    await mutateStore((store) => {
      const acc = store.accounts.find((a) => a.id === account.id);
      if (!acc) return;
      acc.accessToken = accessToken;
      if (json.refresh_token) acc.refreshToken = json.refresh_token;
      acc.expiresAt = Date.now() + json.expires_in * 1000;
      addLog(store, "refresh", `Refreshed access token for "${acc.name}"`);
    });
    return accessToken;
  })();

  inflight.set(account.id, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(account.id);
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

function parseCredentials(raw: string): RawOauthCredentials {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const obj = (parsed.claudeAiOauth ?? parsed) as Partial<RawOauthCredentials>;
  if (!obj.accessToken || !obj.refreshToken || !obj.expiresAt) {
    throw new Error(
      "Credentials JSON must contain accessToken, refreshToken and expiresAt (Claude Code keychain format).",
    );
  }
  return {
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    expiresAt: obj.expiresAt,
    scopes: obj.scopes ?? [],
    subscriptionType: obj.subscriptionType,
  };
}

/**
 * Reads the credentials of whoever is currently logged in to Claude Code on
 * this machine — macOS Keychain first, then ~/.claude/.credentials.json.
 */
export async function readLocalCredentials(): Promise<RawOauthCredentials> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return parseCredentials(stdout.trim());
    } catch {
      // fall through to the credentials file
    }
  }
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  const raw = await fs.readFile(file, "utf8").catch(() => {
    throw new Error(
      "Could not read Claude Code credentials from the macOS Keychain or ~/.claude/.credentials.json. Make sure you are logged in with `claude /login`.",
    );
  });
  return parseCredentials(raw);
}

export function parsePastedCredentials(raw: string): RawOauthCredentials {
  return parseCredentials(raw);
}
