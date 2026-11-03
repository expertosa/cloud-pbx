import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { deprovisionExtension, provisionExtension } from '../engine/provision.js';
import { activeCalls } from '../engine/calls.js';
import { ari } from '../engine/ari.js';
import { hashPassword, randomSecret, requireTenantAdmin, requireTenantUser } from '../lib/auth.js';
import { assertDestination, assertNumberFree, createExtension, HttpError, nextFreeNumber } from '../lib/tenancy.js';
import { businessHoursSchema, destinationSchema, type Extension } from '../lib/types.js';

const extNumber = z.string().regex(/^[1-9][0-9]{1,4}$/, 'رقم التحويلة من 2 إلى 5 أرقام');
const idParam = z.object({ id: z.uuid() });

function publicExtension(e: Extension, includeSecrets = false) {
  const base = {
    id: e.id,
    number: e.number,
    name: e.name,
    user_id: e.user_id,
    voicemail_enabled: e.voicemail_enabled,
    outbound_allowed: e.outbound_allowed,
    sip_username: e.sip_username,
  };
  return includeSecrets ? { ...base, sip_password: e.sip_password, sip_domain: config.sipDomain, sip_port: config.sipPort } : base;
}

export default async function pbxRoutes(app: FastifyInstance) {
  /* ------------------------------ settings ------------------------------ */
  app.get('/api/settings', { preHandler: requireTenantAdmin }, async (req) => {
    return one(
      `select id, name, slug, timezone, record_calls, allow_international, allowed_country_codes, outbound_caller_id,
              daily_outbound_minutes, webhook_url, webhook_secret from tenants where id=$1`,
      [req.user.tid],
    );
  });

  app.patch('/api/settings', { preHandler: requireTenantAdmin }, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        timezone: z.string().refine((tz) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, 'منطقة زمنية غير صحيحة'),
        record_calls: z.boolean(),
        allow_international: z.boolean(),
        allowed_country_codes: z.array(z.string().regex(/^\d{1,4}$/)).max(50),
        outbound_caller_id: z.string().nullable(),
        daily_outbound_minutes: z.number().int().min(0).max(100000),
        webhook_url: z.url().startsWith('https://', 'رابط الـ webhook لازم يبدأ بـ https').nullable().or(z.literal('').transform(() => null)),
      })
      .partial()
      .parse(req.body);
    if (body.outbound_caller_id) {
      const n = await one('select id from phone_numbers where tenant_id=$1 and e164=$2', [req.user.tid, body.outbound_caller_id]);
      if (!n) throw new HttpError(400, 'رقم إظهار المتصل لازم يكون من أرقام شركتك');
    }
    const keys = Object.keys(body) as (keyof typeof body)[];
    if (keys.length) {
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      await q(`update tenants set ${sets} where id=$1`, [req.user.tid, ...keys.map((k) => body[k])]);
    }
    return { ok: true };
  });

  app.post('/api/settings/webhook-secret', { preHandler: requireTenantAdmin }, async (req) => {
    const secret = crypto.randomBytes(24).toString('hex');
    await q('update tenants set webhook_secret=$2 where id=$1', [req.user.tid, secret]);
    return { webhook_secret: secret };
  });

  /* -------------------------------- users ------------------------------- */
  app.get('/api/users', { preHandler: requireTenantAdmin }, async (req) => {
    return q('select id, name, email, role, created_at from users where tenant_id=$1 order by created_at', [req.user.tid]);
  });

  app.post('/api/users', { preHandler: requireTenantAdmin }, async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        email: z.email().transform((e) => e.toLowerCase()),
        password: z.string().min(8).max(200),
        role: z.enum(['admin', 'agent']).default('agent'),
        createExtension: z.boolean().default(true),
        extensionNumber: extNumber.optional(),
      })
      .parse(req.body);
    if (await one('select id from users where email=$1', [body.email])) throw new HttpError(409, 'البريد الإلكتروني مسجل مسبقاً');
    const user = await one('insert into users(tenant_id, name, email, password_hash, role) values ($1,$2,$3,$4,$5) returning id, name, email, role', [
      req.user.tid,
      body.name,
      body.email,
      await hashPassword(body.password),
      body.role,
    ]);
    let extension = null;
    if (body.createExtension) {
      const tenant = await one('select id, slug from tenants where id=$1', [req.user.tid]);
      const number = body.extensionNumber ?? (await nextFreeNumber(req.user.tid!));
      extension = publicExtension(await createExtension(tenant, { number, name: body.name, userId: user.id }));
    }
    return { user, extension };
  });

  app.patch('/api/users/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ name: z.string().trim().min(2).max(120), role: z.enum(['admin', 'agent']), password: z.string().min(8).max(200) })
      .partial()
      .parse(req.body);
    const u = await one('select * from users where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!u) throw new HttpError(404, 'المستخدم غير موجود');
    if (u.role === 'owner' && body.role) throw new HttpError(400, 'لا يمكن تغيير صلاحية مالك الحساب');
    if (body.name) await q('update users set name=$2 where id=$1', [id, body.name]);
    if (body.role) await q('update users set role=$2 where id=$1', [id, body.role]);
    if (body.password) await q('update users set password_hash=$2 where id=$1', [id, await hashPassword(body.password)]);
    return { ok: true };
  });

  app.delete('/api/users/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const u = await one('select role from users where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!u) throw new HttpError(404, 'المستخدم غير موجود');
    if (u.role === 'owner') throw new HttpError(400, 'لا يمكن حذف مالك الحساب');
    await q('delete from users where id=$1', [id]);
    return { ok: true };
  });

  /* ------------------------------ extensions ---------------------------- */
  app.get('/api/extensions', { preHandler: requireTenantUser }, async (req) => {
    const rows = await q<Extension>('select * from extensions where tenant_id=$1 order by number', [req.user.tid]);
    const isAdmin = ['owner', 'admin'].includes(req.user.role);
    // Registration status straight from Asterisk.
    const states = new Map<string, string>();
    try {
      const eps = await ari.get<any[]>('/endpoints/PJSIP');
      for (const ep of eps) states.set(ep.resource, ep.state);
    } catch {
      /* Asterisk unreachable: status unknown */
    }
    return rows.map((e) => ({
      ...publicExtension(e, isAdmin),
      online: states.get(e.sip_username) === 'online' || states.get(e.web_username) === 'online',
    }));
  });

  app.post('/api/extensions', { preHandler: requireTenantAdmin }, async (req) => {
    const body = z
      .object({
        number: extNumber.optional(),
        name: z.string().trim().min(1).max(120),
        user_id: z.uuid().nullable().optional(),
        voicemail_enabled: z.boolean().optional(),
        outbound_allowed: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.user_id && !(await one('select id from users where id=$1 and tenant_id=$2', [body.user_id, req.user.tid])))
      throw new HttpError(400, 'المستخدم غير موجود');
    const tenant = await one('select id, slug from tenants where id=$1', [req.user.tid]);
    const number = body.number ?? (await nextFreeNumber(req.user.tid!));
    const ext = await createExtension(tenant, { ...body, number, userId: body.user_id });
    return publicExtension(ext, true);
  });

  app.patch('/api/extensions/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        user_id: z.uuid().nullable(),
        voicemail_enabled: z.boolean(),
        outbound_allowed: z.boolean(),
      })
      .partial()
      .parse(req.body);
    const ext = await one<Extension>('select * from extensions where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!ext) throw new HttpError(404, 'التحويلة غير موجودة');
    if (body.user_id && !(await one('select id from users where id=$1 and tenant_id=$2', [body.user_id, req.user.tid])))
      throw new HttpError(400, 'المستخدم غير موجود');
    const keys = Object.keys(body) as (keyof typeof body)[];
    if (keys.length) {
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      const updated = await one<Extension>(`update extensions set ${sets} where id=$1 returning *`, [id, ...keys.map((k) => body[k])]);
      await provisionExtension(updated!).catch(() => {});
    }
    return { ok: true };
  });

  app.post('/api/extensions/:id/reset-password', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const updated = await one<Extension>('update extensions set sip_password=$3 where id=$1 and tenant_id=$2 returning *', [id, req.user.tid, randomSecret(20)]);
    if (!updated) throw new HttpError(404, 'التحويلة غير موجودة');
    await provisionExtension(updated);
    return publicExtension(updated, true);
  });

  app.delete('/api/extensions/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await assertNotReferenced(req.user.tid!, 'extension', id);
    await assertNotReferenced(req.user.tid!, 'voicemail', id);
    const ext = await one<Extension>('delete from extensions where id=$1 and tenant_id=$2 returning *', [id, req.user.tid]);
    if (!ext) throw new HttpError(404, 'التحويلة غير موجودة');
    await q('update ring_groups set member_ids = array_remove(member_ids, $2::uuid) where tenant_id=$1', [req.user.tid, id]);
    await deprovisionExtension(ext).catch(() => {});
    return { ok: true };
  });

  /* ------------------------------ ring groups --------------------------- */
  const groupSchema = z.object({
    name: z.string().trim().min(1).max(120),
    number: extNumber.nullable().optional(),
    strategy: z.enum(['simultaneous', 'sequential']).default('simultaneous'),
    ring_seconds: z.number().int().min(5).max(120).default(25),
    member_ids: z.array(z.uuid()).max(50).default([]),
    fallback: destinationSchema.default({ type: 'hangup' }),
  });

  async function checkGroup(tid: string, g: Partial<z.infer<typeof groupSchema>>, id?: string) {
    if (g.number) await assertNumberFree(tid, g.number, id);
    if (g.member_ids?.length) {
      const n = await one<{ c: number }>('select count(*)::int c from extensions where tenant_id=$1 and id = any($2::uuid[])', [tid, g.member_ids]);
      if (n!.c !== new Set(g.member_ids).size) throw new HttpError(400, 'بعض الأعضاء غير موجودين');
    }
    await assertDestination(tid, g.fallback);
    if (id && g.fallback?.type === 'ring_group' && g.fallback.id === id) throw new HttpError(400, 'المجموعة لا يمكن أن تحول لنفسها');
  }

  app.get('/api/ring-groups', { preHandler: requireTenantUser }, async (req) =>
    q('select * from ring_groups where tenant_id=$1 order by created_at', [req.user.tid]),
  );

  app.post('/api/ring-groups', { preHandler: requireTenantAdmin }, async (req) => {
    const g = groupSchema.parse(req.body);
    await checkGroup(req.user.tid!, g);
    return one(
      'insert into ring_groups(tenant_id, name, number, strategy, ring_seconds, member_ids, fallback) values ($1,$2,$3,$4,$5,$6,$7) returning *',
      [req.user.tid, g.name, g.number ?? null, g.strategy, g.ring_seconds, g.member_ids, JSON.stringify(g.fallback)],
    );
  });

  app.put('/api/ring-groups/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const g = groupSchema.parse(req.body);
    await checkGroup(req.user.tid!, g, id);
    const row = await one(
      'update ring_groups set name=$3, number=$4, strategy=$5, ring_seconds=$6, member_ids=$7, fallback=$8 where id=$1 and tenant_id=$2 returning *',
      [id, req.user.tid, g.name, g.number ?? null, g.strategy, g.ring_seconds, g.member_ids, JSON.stringify(g.fallback)],
    );
    if (!row) throw new HttpError(404, 'المجموعة غير موجودة');
    return row;
  });

  app.delete('/api/ring-groups/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await assertNotReferenced(req.user.tid!, 'ring_group', id);
    await q('delete from ring_groups where id=$1 and tenant_id=$2', [id, req.user.tid]);
    return { ok: true };
  });

  /* --------------------------------- IVRs -------------------------------- */
  const ivrSchema = z.object({
    name: z.string().trim().min(1).max(120),
    greeting_id: z.uuid().nullable().default(null),
    options: z.record(z.string().regex(/^[0-9*]$/), destinationSchema).default({}),
    allow_direct_dial: z.boolean().default(true),
    timeout_s: z.number().int().min(2).max(30).default(6),
    timeout_dest: destinationSchema.default({ type: 'hangup' }),
  });

  async function checkIvr(tid: string, v: z.infer<typeof ivrSchema>) {
    if (v.greeting_id && !(await one('select id from audio_files where id=$1 and tenant_id=$2', [v.greeting_id, tid])))
      throw new HttpError(400, 'ملف الترحيب غير موجود');
    for (const d of Object.values(v.options)) await assertDestination(tid, d);
    await assertDestination(tid, v.timeout_dest);
  }

  app.get('/api/ivrs', { preHandler: requireTenantUser }, async (req) => q('select * from ivrs where tenant_id=$1 order by created_at', [req.user.tid]));

  app.post('/api/ivrs', { preHandler: requireTenantAdmin }, async (req) => {
    const v = ivrSchema.parse(req.body);
    await checkIvr(req.user.tid!, v);
    return one(
      'insert into ivrs(tenant_id, name, greeting_id, options, allow_direct_dial, timeout_s, timeout_dest) values ($1,$2,$3,$4,$5,$6,$7) returning *',
      [req.user.tid, v.name, v.greeting_id, JSON.stringify(v.options), v.allow_direct_dial, v.timeout_s, JSON.stringify(v.timeout_dest)],
    );
  });

  app.put('/api/ivrs/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const v = ivrSchema.parse(req.body);
    await checkIvr(req.user.tid!, v);
    const row = await one(
      'update ivrs set name=$3, greeting_id=$4, options=$5, allow_direct_dial=$6, timeout_s=$7, timeout_dest=$8 where id=$1 and tenant_id=$2 returning *',
      [id, req.user.tid, v.name, v.greeting_id, JSON.stringify(v.options), v.allow_direct_dial, v.timeout_s, JSON.stringify(v.timeout_dest)],
    );
    if (!row) throw new HttpError(404, 'الرد الآلي غير موجود');
    return row;
  });

  app.delete('/api/ivrs/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await assertNotReferenced(req.user.tid!, 'ivr', id);
    await q('delete from ivrs where id=$1 and tenant_id=$2', [id, req.user.tid]);
    return { ok: true };
  });

  /* ------------------------------- numbers ------------------------------- */
  app.get('/api/numbers', { preHandler: requireTenantUser }, async (req) =>
    q('select id, e164, label, destination, after_hours_dest, business_hours from phone_numbers where tenant_id=$1 order by e164', [req.user.tid]),
  );

  app.patch('/api/numbers/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        label: z.string().trim().max(120).nullable(),
        destination: destinationSchema,
        after_hours_dest: destinationSchema.nullable(),
        business_hours: businessHoursSchema.nullable(),
      })
      .partial()
      .parse(req.body);
    await assertDestination(req.user.tid!, body.destination);
    await assertDestination(req.user.tid!, body.after_hours_dest);
    const n = await one('select id from phone_numbers where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!n) throw new HttpError(404, 'الرقم غير موجود');
    if ('label' in body) await q('update phone_numbers set label=$2 where id=$1', [id, body.label]);
    if (body.destination) await q('update phone_numbers set destination=$2 where id=$1', [id, JSON.stringify(body.destination)]);
    if ('after_hours_dest' in body) await q('update phone_numbers set after_hours_dest=$2 where id=$1', [id, body.after_hours_dest ? JSON.stringify(body.after_hours_dest) : null]);
    if ('business_hours' in body) await q('update phone_numbers set business_hours=$2 where id=$1', [id, body.business_hours ? JSON.stringify(body.business_hours) : null]);
    return { ok: true };
  });

  /* -------------------------------- calls -------------------------------- */
  app.get('/api/calls', { preHandler: requireTenantUser }, async (req) => {
    const qs = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        direction: z.enum(['inbound', 'outbound', 'internal']).optional(),
        status: z.string().optional(),
        search: z.string().trim().max(40).optional(),
      })
      .parse(req.query);
    const params: unknown[] = [req.user.tid];
    let where = 'c.tenant_id=$1';
    if (qs.direction) {
      params.push(qs.direction);
      where += ` and c.direction=$${params.length}`;
    }
    if (qs.status) {
      params.push(qs.status);
      where += ` and c.status=$${params.length}`;
    }
    if (qs.search) {
      params.push(`%${qs.search}%`);
      where += ` and (c.from_number ilike $${params.length} or c.to_number ilike $${params.length} or c.from_name ilike $${params.length})`;
    }
    // Agents only see calls involving their own extensions.
    if (!['owner', 'admin'].includes(req.user.role)) {
      params.push(req.user.uid);
      where += ` and (c.extension_id in (select id from extensions where user_id=$${params.length}) or c.answered_by in (select id from extensions where user_id=$${params.length}))`;
    }
    const pageSize = 50;
    params.push(pageSize, (qs.page - 1) * pageSize);
    const rows = await q(
      `select c.*, e.number as ext_number, e.name as ext_name, a.number as answered_number, a.name as answered_name
       from calls c
       left join extensions e on e.id = c.extension_id
       left join extensions a on a.id = c.answered_by
       where ${where}
       order by c.started_at desc limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return rows.map((r) => ({ ...r, has_recording: Boolean(r.recording_path), recording_path: undefined, channel_id: undefined }));
  });

  app.get('/api/stats', { preHandler: requireTenantUser }, async (req) => {
    const s = await one(
      `select
         count(*) filter (where started_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone) as today,
         count(*) filter (where started_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone and direction='inbound' and status in ('missed','voicemail')) as missed_today,
         count(*) filter (where started_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone and status='answered') as answered_today,
         coalesce(sum(duration_s) filter (where started_at >= date_trunc('day', now() at time zone t.timezone) at time zone t.timezone), 0) as talk_seconds_today
       from tenants t left join calls c on c.tenant_id = t.id where t.id=$1 group by t.id`,
      [req.user.tid],
    );
    const vm = await one('select count(*)::int as unread from voicemails where tenant_id=$1 and not listened', [req.user.tid]);
    const live = activeCalls().filter((c) => c.tenant_id === req.user.tid).length;
    const numbers = await one('select count(*)::int as c from phone_numbers where tenant_id=$1', [req.user.tid]);
    return {
      today: Number(s?.today ?? 0),
      missed_today: Number(s?.missed_today ?? 0),
      answered_today: Number(s?.answered_today ?? 0),
      talk_minutes_today: Math.round(Number(s?.talk_seconds_today ?? 0) / 60),
      unread_voicemails: vm?.unread ?? 0,
      active_calls: live,
      numbers: numbers?.c ?? 0,
    };
  });

  /* ------------------------------ voicemails ----------------------------- */
  app.get('/api/voicemails', { preHandler: requireTenantUser }, async (req) => {
    const params: unknown[] = [req.user.tid];
    let extra = '';
    if (!['owner', 'admin'].includes(req.user.role)) {
      params.push(req.user.uid);
      extra = ' and v.extension_id in (select id from extensions where user_id=$2)';
    }
    return q(
      `select v.id, v.caller, v.duration_s, v.listened, v.created_at, e.number as ext_number, e.name as ext_name
       from voicemails v left join extensions e on e.id=v.extension_id where v.tenant_id=$1${extra} order by v.created_at desc limit 200`,
      params,
    );
  });

  app.patch('/api/voicemails/:id', { preHandler: requireTenantUser }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ listened: z.boolean() }).parse(req.body);
    await q('update voicemails set listened=$3 where id=$1 and tenant_id=$2', [id, req.user.tid, body.listened]);
    return { ok: true };
  });

  app.delete('/api/voicemails/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await q('delete from voicemails where id=$1 and tenant_id=$2', [id, req.user.tid]);
    return { ok: true };
  });

  /* ------------------------- browser phone config ------------------------ */
  app.get('/api/phone', { preHandler: requireTenantUser }, async (req) => {
    const ext = await one<Extension>('select * from extensions where tenant_id=$1 and user_id=$2 order by number limit 1', [req.user.tid, req.user.uid]);
    if (!ext) return { extension: null };
    return {
      extension: { id: ext.id, number: ext.number, name: ext.name },
      wsUrl: config.sipWsUrl,
      domain: config.sipDomain,
      username: ext.web_username,
      password: ext.web_password,
    };
  });
}

/** Refuse deleting an IVR / ring group that a number, IVR or group still routes to. */
async function assertNotReferenced(tid: string, type: 'ivr' | 'ring_group' | 'extension' | 'voicemail', id: string) {
  const needle = JSON.stringify({ type, id });
  const refs = await q(
    `select 'number' as kind from phone_numbers where tenant_id=$1 and (destination @> $2::jsonb or after_hours_dest @> $2::jsonb)
     union all select 'ivr' from ivrs where tenant_id=$1 and (timeout_dest @> $2::jsonb or exists (select 1 from jsonb_each(options) o where o.value @> $2::jsonb))
     union all select 'group' from ring_groups where tenant_id=$1 and fallback @> $2::jsonb`,
    [tid, needle],
  );
  if (refs.length) throw new HttpError(409, 'هذا العنصر مستخدم في توجيه المكالمات، غيّر التوجيه أولاً');
}
