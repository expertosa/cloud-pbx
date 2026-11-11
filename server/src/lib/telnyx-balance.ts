/** Read-only Telnyx account balance. Never logs the API key. */

export const TELNYX_BALANCE_URL = 'https://api.telnyx.com/v2/balance';
/** Official Mission Control payment page (hash route; login required). */
export const TELNYX_BILLING_URL = 'https://portal.telnyx.com/#/billing/payment';
export const DEFAULT_LOW_THRESHOLD = 10;
export const CACHE_TTL_MS = 60_000;
export const FETCH_TIMEOUT_MS = 8_000;

export type TelnyxBalanceAmounts = {
  balance: string;
  available_credit: string;
  credit_limit: string;
  pending: string;
  currency: string;
};

export type TelnyxBalanceOk = TelnyxBalanceAmounts & {
  configured: true;
  ok: true;
  fetched_at: string;
  low: boolean;
  threshold: number;
  cached: boolean;
  topup_url: string;
};

export type TelnyxBalanceMissing = {
  configured: false;
  ok: false;
  message: string;
  threshold: number;
  topup_url: string;
};

export type TelnyxBalanceError = {
  configured: true;
  ok: false;
  message: string;
  threshold: number;
  topup_url: string;
};

export type TelnyxBalanceView = TelnyxBalanceOk | TelnyxBalanceMissing | TelnyxBalanceError;

export type TelnyxBalanceDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
};

type CacheEntry = { at: number; value: TelnyxBalanceOk };

let cache: CacheEntry | null = null;
let inflight: Promise<TelnyxBalanceView> | null = null;

export function resetTelnyxBalanceCache(): void {
  cache = null;
  inflight = null;
}

export function telnyxApiKey(): string {
  return (process.env.TELNYX_API_KEY ?? '').trim();
}

export function telnyxLowBalanceThreshold(): number {
  const raw = process.env.TELNYX_BALANCE_LOW_THRESHOLD;
  const n = raw === undefined || raw === '' ? DEFAULT_LOW_THRESHOLD : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW_THRESHOLD;
}

export function isLowBalance(availableCredit: string, threshold: number): boolean {
  const amount = Number(availableCredit);
  return Number.isFinite(amount) && amount < threshold;
}

function base(threshold: number) {
  return { threshold, topup_url: TELNYX_BILLING_URL };
}

function parseAmounts(body: unknown): TelnyxBalanceAmounts | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const fields = ['balance', 'available_credit', 'credit_limit', 'pending', 'currency'] as const;
  const out: Partial<TelnyxBalanceAmounts> = {};
  for (const key of fields) {
    const value = rec[key];
    if (typeof value !== 'string' || value.trim() === '') return null;
    out[key] = value;
  }
  return out as TelnyxBalanceAmounts;
}

async function fetchFromTelnyx(deps: TelnyxBalanceDeps, key: string, threshold: number): Promise<TelnyxBalanceView> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(TELNYX_BALANCE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError' || controller.signal.aborted;
    return {
      configured: true,
      ok: false,
      message: aborted ? 'انتهت مهلة طلب الرصيد من Telnyx، حاول مرة ثانية' : 'ما قدرنا نصل لـ Telnyx، حاول مرة ثانية',
      ...base(threshold),
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return {
      configured: true,
      ok: false,
      message: 'مفتاح Telnyx مرفوض أو ما عنده صلاحية قراءة الرصيد',
      ...base(threshold),
    };
  }
  if (!res.ok) {
    return {
      configured: true,
      ok: false,
      message: 'Telnyx ما رجّع الرصيد الحين، حاول مرة ثانية',
      ...base(threshold),
    };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      configured: true,
      ok: false,
      message: 'رد Telnyx غير مفهوم',
      ...base(threshold),
    };
  }
  const amounts = parseAmounts(json);
  if (!amounts) {
    return {
      configured: true,
      ok: false,
      message: 'رد Telnyx غير مفهوم',
      ...base(threshold),
    };
  }
  const now = deps.now ?? Date.now;
  return {
    configured: true,
    ok: true,
    ...amounts,
    fetched_at: new Date(now()).toISOString(),
    low: isLowBalance(amounts.available_credit, threshold),
    cached: false,
    ...base(threshold),
  };
}

export async function getTelnyxBalance(deps: TelnyxBalanceDeps = {}): Promise<TelnyxBalanceView> {
  const threshold = telnyxLowBalanceThreshold();
  const key = telnyxApiKey();
  if (!key) {
    return {
      configured: false,
      ok: false,
      message: 'ما ضبطنا مفتاح Telnyx API بعد. أضف TELNYX_API_KEY في متغيرات البيئة عشان يظهر الرصيد.',
      ...base(threshold),
    };
  }

  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
  if (cache && now() - cache.at < ttl) {
    return { ...cache.value, cached: true, threshold, topup_url: TELNYX_BILLING_URL };
  }

  if (inflight) return inflight;

  inflight = (async () => {
    const result = await fetchFromTelnyx(deps, key, threshold);
    if (result.ok) cache = { at: now(), value: result };
    return result;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
