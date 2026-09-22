import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";
import lockfile from "proper-lockfile";
import { invalidGrant, setupEnv, tokenResponse, type Blob } from "./helpers/harness.mjs";

const env = setupEnv();
const { ensureFreshToken, refreshRejectedToken } = await import("../lib/oauth");
const { getStore, mutateStore } = await import("../lib/store");
type Account = Awaited<ReturnType<typeof getStore>>["accounts"][number];

const MIN = 60_000;
const SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code"];

function oauth(accessToken: string, refreshToken: string, expiresAt: number): Blob {
  return { accessToken, refreshToken, expiresAt, scopes: SCOPES, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" };
}
const tombstone = (): Blob => ({ claudeAiOauth: oauth("", "", 0), mcpOAuth: {} });

async function setAccount(fields: Partial<Account>): Promise<Account> {
  await mutateStore((store) => {
    store.accounts = [{
      id: "acc_primary", name: "Primary", email: null, subscriptionType: "max",
      accessToken: "AT_RELAY", refreshToken: "RT_RELAY", expiresAt: Date.now() + 2 * 60 * MIN, scopes: [],
      addedAt: 0, lastUsedAt: null, requestCount: 0, rateLimitedUntil: null, localKeychain: true,
      ...fields,
    }];
    store.activeAccountId = "acc_primary";
    store.log = [];
  });
  return (await getStore()).accounts[0];
}
const stored = async () => (await getStore()).accounts[0];
const storedOauth = () => env.keychain()?.claudeAiOauth as Record<string, unknown> | undefined;

beforeEach(() => {
  env.reset();
  env.onTokenRequest(() => tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" }));
});

test("leaves a linked token alone before its last minute, so Claude Code refreshes it", async () => {
  const exp = Date.now() + 3 * MIN;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp) });
  const account = await setAccount({ expiresAt: exp });

  assert.equal(await ensureFreshToken(account), "AT_RELAY");
  assert.equal(env.posts.length, 0, "the relay must not race Claude Code's own 5-minute refresh");
});

test("adopts a token Claude Code already refreshed, without a network call", async () => {
  env.setKeychain({ claudeAiOauth: oauth("AT_CC", "RT_CC", Date.now() + 8 * 60 * MIN) });
  const account = await setAccount({ expiresAt: Date.now() + 2 * MIN });

  assert.equal(await ensureFreshToken(account), "AT_CC");
  assert.equal(env.posts.length, 0);
  assert.equal((await stored()).refreshToken, "RT_CC");
});

test("refreshes a linked token in its last minute while holding Claude Code's locks", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp) });
  const account = await setAccount({ expiresAt: exp });
  const held: boolean[] = [];
  env.onTokenRequest(() => {
    held.push(existsSync(path.join(env.claudeDir, ".oauth_refresh.lock")), existsSync(`${env.claudeDir}.lock`));
    return tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" });
  });

  assert.equal(await ensureFreshToken(account), "AT_NEW");
  assert.deepEqual(held, [true, true], "both .oauth_refresh.lock and the legacy ~/.claude.lock");
  assert.equal(env.posts[0].url, "https://platform.claude.com/v1/oauth/token");
  assert.equal(env.posts[0].body.scope, SCOPES.join(" "));
  assert.equal(storedOauth()?.refreshToken, "RT_NEW");
});

test("waits for Claude Code's refresh lock and adopts what it wrote instead of refreshing", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp) });
  const account = await setAccount({ expiresAt: exp });
  const release = await lockfile.lock(env.claudeDir, {
    lockfilePath: path.join(env.claudeDir, ".oauth_refresh.lock"), realpath: false, stale: 60_000, update: 5_000,
  });

  const pending = ensureFreshToken(account);
  await new Promise((r) => setTimeout(r, 400));
  env.setKeychain({ claudeAiOauth: oauth("AT_CC", "RT_CC", Date.now() + 8 * 60 * MIN) });
  await release();

  assert.equal(await pending, "AT_CC");
  assert.equal(env.posts.length, 0);
});

test("a tombstoned Keychain makes the relay use its own token, not the stale credentials file", async () => {
  env.setKeychain(tombstone());
  env.setCredentialsFile({ claudeAiOauth: oauth("AT_FILE", "RT_FILE_DEAD", Date.now() - 40 * 24 * 60 * MIN) });
  const account = await setAccount({ expiresAt: Date.now() + 30_000 });
  env.onTokenRequest(({ body }) =>
    body.refresh_token === "RT_RELAY" ? tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" }) : invalidGrant(),
  );

  assert.equal(await ensureFreshToken(account), "AT_NEW");
  assert.deepEqual(env.posts.map((p) => p.body.refresh_token), ["RT_RELAY"]);
  assert.equal(storedOauth()?.refreshToken, "RT_NEW", "heals the Keychain so Claude Code logs back in");
});

test("401 recovery never replaces the relay's token with expired credentials", async () => {
  env.setKeychain(tombstone());
  env.setCredentialsFile({ claudeAiOauth: oauth("AT_FILE", "RT_FILE_DEAD", Date.now() - 40 * 24 * 60 * MIN) });
  const account = await setAccount({});
  env.onTokenRequest(({ body }) =>
    body.refresh_token === "RT_RELAY" ? tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" }) : invalidGrant(),
  );

  assert.equal(await refreshRejectedToken(account), "AT_NEW");
  assert.notEqual((await stored()).refreshToken, "RT_FILE_DEAD");
});

test("401 recovery adopts a fresh login from the Keychain", async () => {
  env.setKeychain({ claudeAiOauth: oauth("AT_LOGIN", "RT_LOGIN", Date.now() + 8 * 60 * MIN) });
  const account = await setAccount({ expiresAt: Date.now() + 8 * 60 * MIN - 5 * MIN });

  assert.equal(await refreshRejectedToken(account), "AT_LOGIN");
  assert.equal(env.posts.length, 0);
});

test("write-back merges into the Keychain as it is at write time", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp), mcpOAuth: { linear: "v1" } });
  const account = await setAccount({ expiresAt: exp });
  env.onTokenRequest(() => {
    // Claude Code saves an MCP token while our refresh is in flight.
    env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp), mcpOAuth: { linear: "v2" } });
    return tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" });
  });

  await ensureFreshToken(account);
  assert.deepEqual(env.keychain()?.mcpOAuth, { linear: "v2" });
  assert.equal(storedOauth()?.refreshToken, "RT_NEW");
});

test("does not overwrite a login that lands while the refresh is in flight", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp) });
  const account = await setAccount({ expiresAt: exp });
  env.onTokenRequest(() => {
    env.setKeychain({ claudeAiOauth: oauth("AT_LOGIN", "RT_LOGIN", Date.now() + 8 * 60 * MIN) });
    return tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW" });
  });

  await ensureFreshToken(account);
  assert.equal(storedOauth()?.refreshToken, "RT_LOGIN");
});

test("keeps the refresh token lifetime and granted scopes from the token response", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: { ...oauth("AT_RELAY", "RT_RELAY", exp), refreshTokenExpiresAt: 1 } });
  const account = await setAccount({ expiresAt: exp });
  env.onTokenRequest(() =>
    tokenResponse({ access_token: "AT_NEW", refresh_token: "RT_NEW", refresh_token_expires_in: 86_400, scope: "user:inference user:profile" }),
  );

  const before = Date.now();
  await ensureFreshToken(account);
  const saved = storedOauth()!;
  assert.ok((saved.refreshTokenExpiresAt as number) >= before + 86_400_000);
  assert.deepEqual(saved.scopes, ["user:inference", "user:profile"]);
});

test("keeps credentials off the security command line when they fit on stdin", async () => {
  const exp = Date.now() + 30_000;
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp) });
  const account = await setAccount({ expiresAt: exp });

  await ensureFreshToken(account);
  const argv = env.securityCalls().flatMap((c) => c.argv).join(" ");
  assert.ok(storedOauth()?.refreshToken === "RT_NEW");
  assert.ok(!argv.includes("RT_NEW") && !argv.includes("AT_NEW"), "tokens would be visible to anyone running ps");
});

test("an account that is not Claude Code's login refreshes on its own and never touches the Keychain", async () => {
  env.setKeychain({ claudeAiOauth: oauth("AT_OTHER", "RT_OTHER", Date.now() + 8 * 60 * MIN) });
  const account = await setAccount({ localKeychain: false, accessToken: "AT_PASTE", refreshToken: "RT_PASTE", expiresAt: Date.now() + 3 * MIN });

  assert.equal(await ensureFreshToken(account), "AT_NEW");
  assert.deepEqual(env.posts.map((p) => p.body.refresh_token), ["RT_PASTE"]);
  assert.equal(storedOauth()?.refreshToken, "RT_OTHER");
});

test("saves a blob too long for security -i over argv, as Claude Code does", async () => {
  const exp = Date.now() + 30_000;
  // A real Keychain blob with MCP tokens is ~3.5 KB of JSON, ~7 KB hex-encoded.
  env.setKeychain({ claudeAiOauth: oauth("AT_RELAY", "RT_RELAY", exp), mcpOAuth: { pad: "x".repeat(3000) } });
  const account = await setAccount({ expiresAt: exp });

  await ensureFreshToken(account);
  assert.equal(storedOauth()?.refreshToken, "RT_NEW");
  assert.equal((env.keychain()?.mcpOAuth as { pad: string }).pad.length, 3000);
});
