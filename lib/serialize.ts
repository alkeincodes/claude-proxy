import { Account, AccountUsage, Store } from "./store";

export interface PublicAccount {
  id: string;
  name: string;
  email: string | null;
  subscriptionType: string | null;
  tokenTail: string;
  expiresAt: number;
  addedAt: number;
  lastUsedAt: number | null;
  requestCount: number;
  rateLimitedUntil: number | null;
  rateLimitEstimated: boolean;
  usage: AccountUsage | null;
}

export function publicAccount(a: Account): PublicAccount {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    subscriptionType: a.subscriptionType,
    tokenTail: a.accessToken.slice(-6),
    expiresAt: a.expiresAt,
    addedAt: a.addedAt,
    lastUsedAt: a.lastUsedAt,
    requestCount: a.requestCount,
    rateLimitedUntil: a.rateLimitedUntil,
    rateLimitEstimated: a.rateLimitEstimated ?? false,
    usage: a.usage ?? null,
  };
}

export function publicStore(store: Store) {
  return {
    activeAccountId: store.activeAccountId,
    settings: store.settings,
    accounts: store.accounts.map(publicAccount),
    log: store.log,
  };
}
