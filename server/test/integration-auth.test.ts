import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  one: vi.fn(),
  q: vi.fn(async () => []),
  pool: { query: vi.fn() },
}));

vi.mock('../src/engine/calls.js', () => ({
  activeCalls: () => [],
  transferLiveCall: vi.fn(async () => ({ ok: true })),
  hangupLiveCall: vi.fn(async () => ({ ok: true })),
}));

import { buildApp } from '../src/app.js';
import { hangupLiveCall, transferLiveCall } from '../src/engine/calls.js';
import { one } from '../src/db.js';
import { hashServiceToken, parseBearer } from '../src/lib/integration-auth.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const CALL = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'pbx_good-token-value-0123456789';

describe('service token helpers', () => {
  it('hashes the bearer and rejects malformed headers', () => {
    expect(hashServiceToken('pbx_test')).toBe('76c0dfae13304bab3167e847781c9d9fdd58d14ea9404005dbb711c210339d98');
    expect(hashServiceToken('pbx_test')).toHaveLength(64);
    expect(hashServiceToken('pbx_test')).toBe(hashServiceToken('pbx_test'));
    expect(hashServiceToken('other')).not.toBe(hashServiceToken('pbx_test'));
    expect(parseBearer('Bearer pbx_abcdefghijklmnopqrst')).toBe('pbx_abcdefghijklmnopqrst');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });
});

describe('integration API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AI_RECEPTIONIST_ENABLED = 'true';
    vi.mocked(one).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('tenant_integrations') && params?.[0] === hashServiceToken(TOKEN)) {
        return {
          integration_id: 'int-1',
          tenant_id: TENANT,
          name: 'Acme',
          slug: 'acme',
          webhook_url: null,
          webhook_secret: 'whsec',
          disabled: false,
        };
      }
      return null;
    });
  });

  it('rejects missing and unknown tokens', async () => {
    const app = await buildApp();
    const missing = await app.inject({ method: 'POST', url: `/api/integrations/calls/${CALL}/hangup` });
    expect(missing.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/integrations/calls/${CALL}/hangup`,
      headers: { authorization: 'Bearer pbx_not-a-real-token-000' },
    });
    expect(bad.statusCode).toBe(401);
    expect(hangupLiveCall).not.toHaveBeenCalled();
    await app.close();
  });

  it('scopes transfer to the tenant on the token and hides the route when disabled', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/integrations/calls/${CALL}/transfer`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { destination: { type: 'hangup' }, summary: 'يسأل عن الفاتورة', external_ref: 'recv-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(transferLiveCall).toHaveBeenCalledWith(CALL, TENANT, {
      destination: { type: 'hangup' },
      summary: 'يسأل عن الفاتورة',
      externalRef: 'recv-1',
    });

    const nested = await app.inject({
      method: 'POST',
      url: `/api/integrations/calls/${CALL}/transfer`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { destination: { type: 'ai_receptionist' } },
    });
    expect(nested.statusCode).toBe(400);

    process.env.AI_RECEPTIONIST_ENABLED = 'false';
    const hidden = await app.inject({
      method: 'POST',
      url: `/api/integrations/calls/${CALL}/hangup`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(hidden.statusCode).toBe(404);
    await app.close();
  });
});
