import { promises as fs } from "fs";
import path from "path";

export interface WindowUsage {
  /** 0..1 fraction of the window consumed */
  utilization: number | null;
  /** epoch ms when this window resets */
  resetsAt: number | null;
  status: string | null;
}

export interface AccountUsage {
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
  updatedAt: number;
}

export interface Account {
  id: string;
  name: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
  addedAt: number;
  lastUsedAt: number | null;
  requestCount: number;
  /** epoch ms until which this account is known to be rate-limited */
  rateLimitedUntil: number | null;
  /** true when rateLimitedUntil is a guess, not from Anthropic headers */
  rateLimitEstimated?: boolean;
  /** live usage from anthropic-ratelimit-unified-* response headers */
  usage?: AccountUsage | null;
}

export type LogType =
  | "switch"
  | "failover"
  | "limit"
  | "import"
  | "refresh"
  | "error";

export interface LogEntry {
  at: number;
  type: LogType;
  message: string;
}

export interface Store {
  activeAccountId: string | null;
  settings: {
    autoFailover: boolean;
  };
  accounts: Account[];
  log: LogEntry[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "accounts.json");
const MAX_LOG = 80;

const EMPTY: Store = {
  activeAccountId: null,
  settings: { autoFailover: true },
  accounts: [],
  log: [],
};

// Survive dev-server HMR: keep cache + write queue on globalThis.
const g = globalThis as unknown as {
  __claudeProxyStore?: { cache: Store | null; queue: Promise<unknown> };
};
if (!g.__claudeProxyStore) {
  g.__claudeProxyStore = { cache: null, queue: Promise.resolve() };
}
const state = g.__claudeProxyStore;

async function load(): Promise<Store> {
  if (state.cache) return state.cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    state.cache = { ...EMPTY, ...(JSON.parse(raw) as Store) };
  } catch {
    state.cache = structuredClone(EMPTY);
  }
  return state.cache;
}

async function persist(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export function getStore(): Promise<Store> {
  return load();
}

/**
 * Serialized read-modify-write. All mutations go through here so concurrent
 * proxy requests can't clobber each other's writes.
 */
export function mutateStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
  const run = state.queue.then(async () => {
    const store = await load();
    const result = await fn(store);
    await persist(store);
    return result;
  });
  // Keep the queue alive even if this mutation throws.
  state.queue = run.catch(() => {});
  return run;
}

export function addLog(store: Store, type: LogType, message: string): void {
  store.log.unshift({ at: Date.now(), type, message });
  if (store.log.length > MAX_LOG) store.log.length = MAX_LOG;
}

export function activeAccount(store: Store): Account | null {
  return store.accounts.find((a) => a.id === store.activeAccountId) ?? null;
}

export function newAccountId(): string {
  return "acc_" + Math.random().toString(36).slice(2, 10);
}
