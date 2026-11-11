import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE } from '../src/lib/auth.js';
import {
  CACHE_TTL_MS,
  getTelnyxBalance,
  resetTelnyxBalanceCache,
  TELNYX_BALANCE_URL,
  TELNYX_BILLING_URL,
} from '../src/lib/telnyx-balance.js';

vi.mock('../src/db.js', () => ({
  one: vi.fn(),
  q: vi.fn(async () => []),
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../src/engine/calls.js', () => ({
  activeCalls: () => [],
}));

vi.mock('../src/engine/ari.js', () => ({
  ari: { connected: false, get: vi.fn() },
}));

import { buildApp } from '../src/app.js';

const SAMPLE = {
  data: {
    record_type: 'balance',
    pending: '10.00',
    balance: '300.00',
    credit_limit: '100.00',
    available_credit: '400.00',
    currency: 'USD',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('getTelnyxBalance', () => {
  beforeEach(() => {
    resetTelnyxBalanceCache();
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_BALANCE_LOW_THRESHOLD;
  });

  afterEach(() => {
    resetTelnyxBalanceCache();
    delete process.env.TELNYX_API_KEY;
    delete process.env.TELNYX_BALANCE_LOW_THRESHOLD;
  });

  it('returns a graceful payload when the API key is missing', async () => {
    const fetchMock = vi.fn();
    const result = await getTelnyxBalance({ fetch: fetchMock });
    expect(result).toMatchObject({
      configured: false,
      ok: false,
      threshold: 10,
      topup_url: TELNYX_BILLING_URL,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/TELNYX_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns amounts, currency, and a low-balance flag', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(TELNYX_BALANCE_URL);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer KEYKEYKEY');
      return jsonResponse(SAMPLE);
    });
    const result = await getTelnyxBalance({ fetch: fetchMock as typeof fetch, now: () => Date.parse('2026-11-11T06:00:00Z') });
    expect(result).toEqual({
      configured: true,
      ok: true,
      pending: '10.00',
      balance: '300.00',
      credit_limit: '100.00',
      available_credit: '400.00',
      currency: 'USD',
      fetched_at: '2026-11-11T06:00:00.000Z',
      low: false,
      threshold: 10,
      cached: false,
      topup_url: TELNYX_BILLING_URL,
    });
  });

  it('warns when available_credit is below the threshold', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    process.env.TELNYX_BALANCE_LOW_THRESHOLD = '50';
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { ...SAMPLE.data, available_credit: '12.50', balance: '12.50', credit_limit: '0.00', pending: '0.00' },
      }),
    );
    const result = await getTelnyxBalance({ fetch: fetchMock as typeof fetch });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.low).toBe(true);
      expect(result.threshold).toBe(50);
    }
  });

  it('caches a successful reading for about 60 seconds', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE));
    let now = 1_000_000;
    const first = await getTelnyxBalance({ fetch: fetchMock as typeof fetch, now: () => now });
    const second = await getTelnyxBalance({ fetch: fetchMock as typeof fetch, now: () => now + CACHE_TTL_MS - 1 });
    expect(first.ok && !first.cached).toBe(true);
    expect(second.ok && second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = 1_000_000 + CACHE_TTL_MS;
    const third = await getTelnyxBalance({ fetch: fetchMock as typeof fetch, now: () => now });
    expect(third.ok && !third.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hanging Telnyx request', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const result = await getTelnyxBalance({ fetch: fetchMock as typeof fetch, timeoutMs: 20 });
    expect(result).toMatchObject({ configured: true, ok: false });
    if (!result.ok && result.configured) expect(result.message).toMatch(/مهلة/);
  });

  it('handles a rejected key and an invalid payload without throwing', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    const forbidden = await getTelnyxBalance({ fetch: (async () => jsonResponse({ errors: [] }, 403)) as typeof fetch });
    expect(forbidden).toMatchObject({ configured: true, ok: false });
    resetTelnyxBalanceCache();
    const bad = await getTelnyxBalance({ fetch: (async () => jsonResponse({ data: { balance: 1 } })) as typeof fetch });
    expect(bad).toMatchObject({ configured: true, ok: false });
  });
});

describe('GET /api/admin/telnyx-balance', () => {
  beforeEach(() => {
    resetTelnyxBalanceCache();
    delete process.env.TELNYX_API_KEY;
  });

  afterEach(async () => {
    resetTelnyxBalanceCache();
    delete process.env.TELNYX_API_KEY;
  });

  async function session(app: Awaited<ReturnType<typeof buildApp>>, role: 'superadmin' | 'admin' | 'owner') {
    const token = app.jwt.sign({
      uid: '11111111-1111-4111-8111-111111111111',
      tid: role === 'superadmin' ? null : '22222222-2222-4222-8222-222222222222',
      role,
    });
    return { cookie: `${COOKIE}=${token}` };
  }

  it('rejects anonymous and tenant-admin callers', async () => {
    const app = await buildApp();
    const anon = await app.inject({ method: 'GET', url: '/api/admin/telnyx-balance' });
    expect(anon.statusCode).toBe(401);
    const admin = await app.inject({
      method: 'GET',
      url: '/api/admin/telnyx-balance',
      headers: { cookie: (await session(app, 'admin')).cookie },
    });
    expect(admin.statusCode).toBe(403);
    const owner = await app.inject({
      method: 'GET',
      url: '/api/admin/telnyx-balance',
      headers: { cookie: (await session(app, 'owner')).cookie },
    });
    expect(owner.statusCode).toBe(403);
    await app.close();
  });

  it('returns the balance payload to a superadmin', async () => {
    process.env.TELNYX_API_KEY = 'KEYKEYKEY';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE));
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/telnyx-balance',
      headers: { cookie: (await session(app, 'superadmin')).cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.available_credit).toBe('400.00');
    expect(body.balance).toBe('300.00');
    expect(body.currency).toBe('USD');
    expect(body.topup_url).toBe(TELNYX_BILLING_URL);
    fetchMock.mockRestore();
    await app.close();
  });

  it('tells a superadmin when the key is not configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/telnyx-balance',
      headers: { cookie: (await session(app, 'superadmin')).cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, ok: false, topup_url: TELNYX_BILLING_URL });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
    await app.close();
  });
});
