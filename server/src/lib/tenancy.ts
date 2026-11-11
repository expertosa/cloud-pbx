import { aiReceptionistSettings } from '../config.js';
import { one, q } from '../db.js';
import { randomSecret } from './auth.js';
import type { Destination, Extension } from './types.js';
import { provisionExtension } from '../engine/provision.js';
import { logger } from './logger.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function makeSlug(): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/** Throws 400 when a destination points at something outside the tenant, or at the AI receptionist while the flag is off. */
export async function assertDestination(tenantId: string, d: Destination | null | undefined): Promise<void> {
  if (!d || d.type === 'hangup') return;
  if (d.type === 'ai_receptionist') {
    if (!aiReceptionistSettings().enabled) throw new HttpError(400, 'الموظف الذكي غير مفعّل');
    await assertDestination(tenantId, d.fallback);
    return;
  }
  const table = { extension: 'extensions', voicemail: 'extensions', ring_group: 'ring_groups', ivr: 'ivrs' }[d.type];
  const row = await one(`select id from ${table} where tenant_id=$1 and id=$2`, [tenantId, d.id]);
  if (!row) throw new HttpError(400, 'الوجهة المختارة غير موجودة');
}

/** A number must not clash between extensions and ring groups of the same tenant. */
export async function assertNumberFree(tenantId: string, number: string, except?: string): Promise<void> {
  const e = await one('select id from extensions where tenant_id=$1 and number=$2 and id <> coalesce($3::uuid, gen_random_uuid())', [tenantId, number, except ?? null]);
  const g = await one('select id from ring_groups where tenant_id=$1 and number=$2 and id <> coalesce($3::uuid, gen_random_uuid())', [tenantId, number, except ?? null]);
  if (e || g) throw new HttpError(409, `الرقم ${number} مستخدم مسبقاً`);
}

export async function createExtension(
  tenant: { id: string; slug: string },
  input: { number: string; name: string; userId?: string | null; voicemail_enabled?: boolean; outbound_allowed?: boolean },
): Promise<Extension> {
  await assertNumberFree(tenant.id, input.number);
  const ext = await one<Extension>(
    `insert into extensions(tenant_id, number, name, user_id, sip_username, sip_password, web_username, web_password, voicemail_enabled, outbound_allowed)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [
      tenant.id,
      input.number,
      input.name,
      input.userId ?? null,
      `${tenant.slug}${input.number}`,
      randomSecret(20),
      `w${tenant.slug}${input.number}`,
      randomSecret(24),
      input.voicemail_enabled ?? true,
      input.outbound_allowed ?? true,
    ],
  );
  try {
    await provisionExtension(ext!);
  } catch (e) {
    // Asterisk may be down; the extension is re-synced when ARI reconnects.
    logger.warn({ err: String(e) }, 'extension saved but not provisioned yet');
  }
  return ext!;
}

export async function nextFreeNumber(tenantId: string, start = 101): Promise<string> {
  const used = new Set(
    (await q<{ number: string }>('select number from extensions where tenant_id=$1 union select number from ring_groups where tenant_id=$1 and number is not null', [tenantId])).map(
      (r) => r.number,
    ),
  );
  let n = start;
  while (used.has(String(n))) n++;
  return String(n);
}
