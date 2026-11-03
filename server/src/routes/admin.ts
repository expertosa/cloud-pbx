import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { ari } from '../engine/ari.js';
import { activeCalls } from '../engine/calls.js';
import { requireSuperadmin } from '../lib/auth.js';
import { normalizeDid } from '../lib/phone.js';
import { HttpError } from '../lib/tenancy.js';
import { createTenantWithOwner } from './auth.js';

/** Platform-operator routes: onboard companies and hand out carrier numbers. */
export default async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/status', { preHandler: requireSuperadmin }, async () => {
    let trunk: unknown = null;
    let asterisk: unknown = null;
    try {
      asterisk = (await ari.get('/asterisk/info', { only: 'system' })).system;
      const ep = await ari.get(`/endpoints/PJSIP/${config.trunkEndpoint}`).catch(() => null);
      trunk = ep ? { endpoint: config.trunkEndpoint, state: ep.state, channels: ep.channel_ids?.length ?? 0 } : { endpoint: config.trunkEndpoint, state: 'missing' };
    } catch (e) {
      asterisk = { error: String(e) };
    }
    return { ari_connected: ari.connected, asterisk, trunk, active_calls: activeCalls().length };
  });

  app.get('/api/admin/tenants', { preHandler: requireSuperadmin }, async () =>
    q(`select t.id, t.name, t.slug, t.disabled, t.created_at,
              (select count(*)::int from extensions e where e.tenant_id=t.id) as extensions,
              (select count(*)::int from phone_numbers n where n.tenant_id=t.id) as numbers,
              (select count(*)::int from calls c where c.tenant_id=t.id and c.started_at > now() - interval '30 days') as calls_30d,
              (select email from users u where u.tenant_id=t.id and u.role='owner' limit 1) as owner_email
       from tenants t order by t.created_at desc`),
  );

  app.post('/api/admin/tenants', { preHandler: requireSuperadmin }, async (req) => {
    const body = z
      .object({
        company: z.string().trim().min(2).max(120),
        name: z.string().trim().min(2).max(120),
        email: z.email().transform((e) => e.toLowerCase()),
        password: z.string().min(8).max(200),
      })
      .parse(req.body);
    const { tenant } = await createTenantWithOwner(body);
    return tenant;
  });

  app.patch('/api/admin/tenants/:id', { preHandler: requireSuperadmin }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ disabled: z.boolean() }).parse(req.body);
    await q('update tenants set disabled=$2 where id=$1', [id, body.disabled]);
    return { ok: true };
  });

  app.get('/api/admin/numbers', { preHandler: requireSuperadmin }, async () =>
    q('select n.id, n.e164, n.label, n.tenant_id, t.name as tenant_name from phone_numbers n left join tenants t on t.id=n.tenant_id order by n.e164'),
  );

  app.post('/api/admin/numbers', { preHandler: requireSuperadmin }, async (req) => {
    const body = z.object({ e164: z.string(), tenant_id: z.uuid().nullable().optional(), label: z.string().max(120).optional() }).parse(req.body);
    const e164 = normalizeDid(body.e164);
    if (!e164) throw new HttpError(400, 'اكتب الرقم بصيغة دولية مثل +15551234567');
    if (await one('select id from phone_numbers where e164=$1', [e164])) throw new HttpError(409, 'الرقم مضاف مسبقاً');
    return one('insert into phone_numbers(e164, tenant_id, label) values ($1,$2,$3) returning *', [e164, body.tenant_id ?? null, body.label ?? null]);
  });

  app.patch('/api/admin/numbers/:id', { preHandler: requireSuperadmin }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z.object({ tenant_id: z.uuid().nullable() }).parse(req.body);
    // Re-assigning a number resets its routing so it never points into another company,
    // and the previous owner can no longer present it as caller ID.
    const prev = await one('select e164, tenant_id from phone_numbers where id=$1', [id]);
    if (prev?.tenant_id && prev.tenant_id !== body.tenant_id)
      await q('update tenants set outbound_caller_id=null where id=$1 and outbound_caller_id=$2', [prev.tenant_id, prev.e164]);
    await q(`update phone_numbers set tenant_id=$2, destination='{"type":"hangup"}', after_hours_dest=null, business_hours=null where id=$1`, [
      id,
      body.tenant_id,
    ]);
    return { ok: true };
  });

  app.delete('/api/admin/numbers/:id', { preHandler: requireSuperadmin }, async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const n = await one('select e164, tenant_id from phone_numbers where id=$1', [id]);
    if (n?.tenant_id) await q('update tenants set outbound_caller_id=null where id=$1 and outbound_caller_id=$2', [n.tenant_id, n.e164]);
    await q('delete from phone_numbers where id=$1', [id]);
    return { ok: true };
  });
}
