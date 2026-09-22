import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import path from "path";

export type Blob = Record<string, unknown>;
export interface Post {
  url: string;
  body: Record<string, string>;
}
export type TokenHandler = (post: Post) => Promise<Response> | Response;

/**
 * Isolated HOME, a fake `security` first on PATH, and a fresh working
 * directory for the relay's data store. Call before importing lib/oauth.
 */
export function setupEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "claude-proxy-test-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  const claudeDir = path.join(home, ".claude");
  for (const d of [claudeDir, bin, path.join(work, "data")]) mkdirSync(d, { recursive: true });
  const fake = path.join(import.meta.dirname, "security.mjs");
  chmodSync(fake, 0o755);
  symlinkSync(fake, path.join(bin, "security"));

  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_SECURITY_DIR = root;
  process.chdir(work);
  // The relay writes the real Keychain service name. If the fake did not win
  // on PATH, the tests would overwrite the real login, so refuse to run.
  if (spawnSync("security", ["--probe"], { encoding: "utf8" }).stdout !== "fake-security") {
    throw new Error("fake security is not first on PATH; refusing to touch the real Keychain");
  }

  const itemFile = path.join(root, "keychain.json");
  const callsFile = path.join(root, "calls.jsonl");
  const credentialsFile = path.join(claudeDir, ".credentials.json");
  const posts: Post[] = [];
  let handler: TokenHandler = () => new Response("{}", { status: 500 });

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const post = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
    posts.push(post);
    return handler(post);
  }) as typeof fetch;

  return {
    home,
    claudeDir,
    posts,
    onTokenRequest(h: TokenHandler) {
      handler = h;
    },
    setKeychain(blob: Blob | null) {
      if (blob === null) rmSync(itemFile, { force: true });
      else writeFileSync(itemFile, JSON.stringify({ account: "tester", service: "Claude Code-credentials", password: JSON.stringify(blob) }));
    },
    keychain(): Blob | null {
      if (!existsSync(itemFile)) return null;
      return JSON.parse(JSON.parse(readFileSync(itemFile, "utf8")).password) as Blob;
    },
    setCredentialsFile(blob: Blob | null) {
      if (blob === null) rmSync(credentialsFile, { force: true });
      else writeFileSync(credentialsFile, JSON.stringify(blob));
    },
    securityCalls(): { argv: string[]; stdin: string | null }[] {
      if (!existsSync(callsFile)) return [];
      return readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    reset() {
      posts.length = 0;
      rmSync(callsFile, { force: true });
      rmSync(itemFile, { force: true });
      rmSync(credentialsFile, { force: true });
    },
  };
}

export function tokenResponse(fields: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ expires_in: 28800, ...fields }), { status: 200 });
}

export function invalidGrant(): Response {
  return new Response('{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}', { status: 400 });
}
