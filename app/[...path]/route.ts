import { promises as fs } from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { ensureFreshToken } from "@/lib/oauth";
import {
  Account,
  activeAccount,
  addLog,
  getStore,
  mutateStore,
  WindowUsage,
} from "@/lib/store";

export const dynamic = "force-dynamic";

const UPSTREAM = "https://api.anthropic.com";

/**
 * Local CLIProxyAPI instance that serves non-Claude models (gpt-5.6-*,
 * gemini-*, grok-*, …) behind an Anthropic-compatible /v1/messages endpoint.
 */
const GATEWAY_BASE = process.env.CLIPROXY_BASE_URL ?? "http://127.0.0.1:8317";
const GATEWAY_KEY = process.env.CLIPROXY_API_KEY ?? "";

/** Headers we must not forward verbatim in either direction. */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "x-api-key",
  "authorization",
]);
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Copy request headers, dropping the ones we never forward verbatim. */
function forwardableHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

/** Rebuild the response, dropping hop-by-hop headers, streaming the body. */
function relayResponse(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function upstreamHeaders(req: NextRequest, token: string): Headers {
  const headers = forwardableHeaders(req);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

/** Anthropic model ids all begin with "claude"; anything else is non-Claude. */
function isClaudeModel(model: string): boolean {
  return model.startsWith("claude");
}

/**
 * Pull the target model out of the buffered request body. Claude Code sends
 * JSON with a top-level `model`; anything else (no body, non-JSON, no model)
 * yields null so the caller falls back to the Anthropic path.
 */
function modelFromBody(body: ArrayBuffer | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

/**
 * Forward a non-Claude request to the local CLIProxyAPI gateway. No Anthropic
 * account, OAuth token, failover, or usage tracking is involved here — the
 * gateway authenticates with its own key and serves the alternate models.
 */
async function proxyToGateway(
  req: NextRequest,
  target: string,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  const headers = forwardableHeaders(req);
  // Only send an api-key when one is configured; leave it off otherwise.
  if (GATEWAY_KEY) headers.set("x-api-key", GATEWAY_KEY);

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (err) {
    return Response.json(
      { error: { type: "proxy_error", message: `claude-proxy: gateway request failed: ${String(err)}` } },
      { status: 502 },
    );
  }
  return relayResponse(res);
}

interface UnifiedLimits {
  status: string | null;
  resetAt: number | null;
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
}

/**
 * Anthropic attaches live usage to (most) responses:
 *   anthropic-ratelimit-unified-status: allowed | allowed_warning | rejected
 *   anthropic-ratelimit-unified-reset: epoch seconds
 *   anthropic-ratelimit-unified-{5h,7d}-{status,reset,utilization}
 */
function readUnified(res: Response): UnifiedLimits | null {
  const get = (k: string) => res.headers.get(k);
  if (
    !get("anthropic-ratelimit-unified-status") &&
    !get("anthropic-ratelimit-unified-5h-status")
  ) {
    return null;
  }
  const num = (v: string | null) =>
    v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;
  const epoch = (v: string | null) => {
    const n = num(v);
    return n && n > 1_000_000_000 ? n * 1000 : null;
  };
  const window = (prefix: string): WindowUsage => ({
    utilization: num(get(`anthropic-ratelimit-unified-${prefix}-utilization`)),
    resetsAt: epoch(get(`anthropic-ratelimit-unified-${prefix}-reset`)),
    status: get(`anthropic-ratelimit-unified-${prefix}-status`),
  });
  return {
    status: get("anthropic-ratelimit-unified-status"),
    resetAt: epoch(get("anthropic-ratelimit-unified-reset")),
    fiveHour: window("5h"),
    sevenDay: window("7d"),
  };
}

/** Reset time from 429 headers: unified first, then retry-after (secs or date). */
function parseLimitReset(res: Response): number | null {
  const unified = readUnified(res);
  if (unified?.resetAt) return unified.resetAt;
  if (unified?.fiveHour.resetsAt) return unified.fiveHour.resetsAt;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Date.now() + Number(retryAfter) * 1000;
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return asDate;
  }
  return null;
}

/**
 * Claude subscription limit errors often carry the reset epoch in the body,
 * e.g. "Claude AI usage limit reached|1783344600".
 */
function parseResetFromBody(text: string): number | null {
  const piped = text.match(/\|(\d{10})\b/);
  if (piped) return Number(piped[1]) * 1000;
  const field = text.match(/"resets?_?at"\s*:\s*"?(\d{10})\b/i);
  if (field) return Number(field[1]) * 1000;
  return null;
}

/** Dump the last 429 verbatim so limit parsing is debuggable after the fact. */
function captureDebug429(res: Response, bodyText: string): void {
  const record = {
    at: new Date().toISOString(),
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: bodyText.slice(0, 2000),
  };
  void fs
    .writeFile(
      path.join(process.cwd(), "data", "last-429.json"),
      JSON.stringify(record, null, 2),
    )
    .catch(() => {});
}

async function attempt(
  req: NextRequest,
  target: string,
  account: Account,
  body: ArrayBuffer | undefined,
): Promise<Response> {
  const token = await ensureFreshToken(account);
  return fetch(target, {
    method: req.method,
    headers: upstreamHeaders(req, token),
    body,
    redirect: "manual",
  });
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path: segments } = await ctx.params;
  const search = new URL(req.url).search;
  const target = `${UPSTREAM}/${segments.join("/")}${search}`;

  // Buffer the body so we can replay it on failover and inspect the model.
  // Claude Code bodies are JSON, so this is cheap. GET/HEAD have no body.
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.arrayBuffer();

  // Non-Claude models (gpt-5.6-*, gemini-*, …) go to the local CLIProxyAPI
  // gateway instead of Anthropic — no account, token, or failover needed.
  const model = modelFromBody(body);
  if (model && !isClaudeModel(model)) {
    const gatewayTarget = `${GATEWAY_BASE}/${segments.join("/")}${search}`;
    return proxyToGateway(req, gatewayTarget, body);
  }

  const store = await getStore();
  const active = activeAccount(store);
  if (!active) {
    return Response.json(
      { error: { type: "proxy_error", message: "claude-proxy: no active account configured — open the dashboard and import one" } },
      { status: 503 },
    );
  }

  let served = active;
  let res: Response;
  try {
    res = await attempt(req, target, active, body);
  } catch (err) {
    return Response.json(
      { error: { type: "proxy_error", message: `claude-proxy: upstream request failed: ${String(err)}` } },
      { status: 502 },
    );
  }

  if (res.status === 429) {
    // 429 bodies are small JSON; buffer for reset parsing + debug capture,
    // and rebuild the response afterwards.
    const text429 = await res.text().catch(() => "");
    captureDebug429(res, text429);
    const resetAt = parseLimitReset(res) ?? parseResetFromBody(text429);

    const fallback = await mutateStore((s) => {
      const acc = s.accounts.find((a) => a.id === active.id);
      let effectiveReset = resetAt;
      if (acc) {
        // Last-known 5h window boundary beats a blind guess.
        const knownWindow =
          acc.usage?.fiveHour.resetsAt && acc.usage.fiveHour.resetsAt > Date.now()
            ? acc.usage.fiveHour.resetsAt
            : null;
        effectiveReset = resetAt ?? knownWindow;
        acc.rateLimitedUntil = effectiveReset ?? Date.now() + 60 * 60 * 1000;
        acc.rateLimitEstimated = !resetAt;
      }
      addLog(
        s,
        "limit",
        `"${active.name}" hit its limit${
          effectiveReset
            ? ` (resets ${new Date(effectiveReset).toLocaleTimeString()}${resetAt ? "" : ", estimated"})`
            : " (reset time unknown, assuming 1h)"
        }`,
      );
      if (!s.settings.autoFailover) return null;
      const next = s.accounts.find(
        (a) =>
          a.id !== active.id &&
          (!a.rateLimitedUntil || a.rateLimitedUntil < Date.now()),
      );
      if (!next) return null;
      s.activeAccountId = next.id;
      addLog(s, "failover", `Auto-switched: "${active.name}" → "${next.name}"`);
      return next;
    });

    let retried: Response | null = null;
    if (fallback) {
      try {
        retried = await attempt(req, target, fallback, body);
        served = fallback;
      } catch {
        // keep the original 429 semantics if the retry itself blows up
      }
    }
    res =
      retried ??
      new Response(text429, {
        status: 429,
        statusText: res.statusText,
        headers: res.headers,
      });
  }

  // Live usage + stats, keyed to whichever account actually served the
  // response. Fire-and-forget; don't block the stream on a file write.
  const unified = readUnified(res);
  const servedId = served.id;
  const ok = res.ok;
  void mutateStore((s) => {
    const acc = s.accounts.find((a) => a.id === servedId);
    if (!acc) return;
    acc.requestCount += 1;
    acc.lastUsedAt = Date.now();
    if (unified) {
      acc.usage = {
        fiveHour: unified.fiveHour,
        sevenDay: unified.sevenDay,
        updatedAt: Date.now(),
      };
      if (unified.status === "allowed" || unified.status === "allowed_warning") {
        // Authoritative: Anthropic says this account may make requests.
        acc.rateLimitedUntil = null;
        acc.rateLimitEstimated = false;
      } else if (unified.status === "rejected" && unified.resetAt) {
        acc.rateLimitedUntil = unified.resetAt;
        acc.rateLimitEstimated = false;
      }
    } else if (ok && acc.rateLimitedUntil && acc.rateLimitedUntil < Date.now()) {
      acc.rateLimitedUntil = null;
      acc.rateLimitEstimated = false;
    }
  }).catch(() => {});

  return relayResponse(res);
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as HEAD,
  proxy as OPTIONS,
};
