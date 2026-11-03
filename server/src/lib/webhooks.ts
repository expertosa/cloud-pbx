import crypto from 'node:crypto';
import { q } from '../db.js';
import { logger } from './logger.js';
import type { Tenant } from './types.js';

/**
 * Fire-and-forget webhook delivery. The body is signed with HMAC-SHA256 using the
 * tenant's webhook secret; receivers verify the X-CloudPBX-Signature header.
 */
export function sendWebhook(tenant: Pick<Tenant, 'id' | 'webhook_url' | 'webhook_secret'>, event: string, data: unknown): void {
  if (!tenant.webhook_url) return;
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data });
  const signature = crypto.createHmac('sha256', tenant.webhook_secret).update(body).digest('hex');
  const url = tenant.webhook_url;
  (async () => {
    let status: number | null = null;
    let error: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CloudPBX-Event': event, 'X-CloudPBX-Signature': `sha256=${signature}` },
          body,
          signal: AbortSignal.timeout(5000),
        });
        status = res.status;
        error = null;
        if (res.ok) break;
      } catch (e) {
        error = String(e);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) * 2));
    }
    await q('insert into webhook_deliveries(tenant_id, event, status_code, error) values ($1,$2,$3,$4)', [tenant.id, event, status, error]).catch(
      (e) => logger.warn({ err: String(e) }, 'failed to log webhook delivery'),
    );
  })();
}
