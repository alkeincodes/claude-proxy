import {
  fetchProfileEmail,
  parsePastedCredentials,
  RawOauthCredentials,
  readLocalCredentials,
} from "@/lib/oauth";
import { publicStore } from "@/lib/serialize";
import { addLog, getStore, mutateStore, newAccountId } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await getStore();
  return Response.json(publicStore(store));
}

interface ImportBody {
  source: "local" | "paste";
  name?: string;
  credentials?: string;
}

export async function POST(req: Request) {
  let body: ImportBody;
  try {
    body = (await req.json()) as ImportBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let creds: RawOauthCredentials;
  try {
    creds =
      body.source === "paste"
        ? parsePastedCredentials(body.credentials ?? "")
        : await readLocalCredentials();
  } catch (err) {
    return Response.json({ error: String((err as Error).message ?? err) }, { status: 400 });
  }

  const email = await fetchProfileEmail(creds.accessToken);
  // Credentials read off this machine stay shared with Claude Code, which
  // rotates the refresh token behind our back. lib/oauth.ts needs to know.
  const localKeychain = body.source !== "paste";

  const result = await mutateStore((store) => {
    // Same underlying account already saved? Update it in place instead of
    // duplicating. Email is the most stable identity; fall back to token.
    const existing = store.accounts.find(
      (a) =>
        (email && a.email === email) ||
        a.refreshToken === creds.refreshToken ||
        a.accessToken === creds.accessToken,
    );
    if (existing) {
      if (localKeychain) {
        for (const account of store.accounts) {
          account.localKeychain = account.id === existing.id;
        }
      }
      existing.accessToken = creds.accessToken;
      existing.refreshToken = creds.refreshToken;
      existing.expiresAt = creds.expiresAt;
      existing.scopes = creds.scopes ?? existing.scopes;
      existing.subscriptionType = creds.subscriptionType ?? existing.subscriptionType;
      if (email) existing.email = email;
      if (body.name?.trim()) existing.name = body.name.trim();
      addLog(store, "import", `Updated credentials for "${existing.name}"`);
      return { account: existing, updated: true };
    }

    if (localKeychain) {
      for (const account of store.accounts) account.localKeychain = false;
    }
    const account = {
      id: newAccountId(),
      name: body.name?.trim() || email || `Account ${store.accounts.length + 1}`,
      email,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes ?? [],
      subscriptionType: creds.subscriptionType ?? null,
      addedAt: Date.now(),
      lastUsedAt: null,
      requestCount: 0,
      rateLimitedUntil: null,
      localKeychain,
    };
    store.accounts.push(account);
    if (!store.activeAccountId) store.activeAccountId = account.id;
    addLog(store, "import", `Imported "${account.name}"${email ? ` (${email})` : ""}`);
    return { account, updated: false };
  });

  const store = await getStore();
  return Response.json({ ...publicStore(store), imported: result.account.id });
}
