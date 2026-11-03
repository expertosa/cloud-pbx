import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, pool } from '../db.js';
import { checkPassword, COOKIE, hashPassword, requireUser, type SessionUser } from '../lib/auth.js';
import { createExtension, HttpError, makeSlug } from '../lib/tenancy.js';

const signupSchema = z.object({
  company: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
});

/** Creates a company with its owner and first extension. Used by signup and by the platform admin. */
export async function createTenantWithOwner(input: z.infer<typeof signupSchema>) {
  const exists = await one('select id from users where email=$1', [input.email]);
  if (exists) throw new HttpError(409, 'البريد الإلكتروني مسجل مسبقاً');
  const client = await pool.connect();
  let tenant: any;
  let user: any;
  try {
    await client.query('begin');
    for (let i = 0; i < 5 && !tenant; i++) {
      const r = await client.query('insert into tenants(name, slug) values ($1,$2) on conflict (slug) do nothing returning *', [input.company, makeSlug()]);
      tenant = r.rows[0];
    }
    user = (
      await client.query(`insert into users(tenant_id, name, email, password_hash, role) values ($1,$2,$3,$4,'owner') returning id, tenant_id, name, email, role`, [
        tenant.id,
        input.name,
        input.email,
        await hashPassword(input.password),
      ])
    ).rows[0];
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  await createExtension(tenant, { number: '101', name: input.name, userId: user.id });
  return { tenant, user };
}

export default async function authRoutes(app: FastifyInstance) {
  const setSession = (reply: any, u: SessionUser) => {
    const token = app.jwt.sign(u, { expiresIn: '14d' });
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: 14 * 24 * 3600,
    });
  };

  app.post('/api/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!config.allowSignup) return reply.code(403).send({ message: 'التسجيل الذاتي مغلق، تواصل معنا لفتح حساب' });
    const body = signupSchema.parse(req.body);
    const { tenant, user } = await createTenantWithOwner(body);
    setSession(reply, { uid: user.id, tid: tenant.id, role: 'owner' });
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const u = await one('select * from users where email=$1', [body.email]);
    if (!u || !(await checkPassword(body.password, u.password_hash))) {
      return reply.code(401).send({ message: 'البريد أو كلمة المرور غير صحيحة' });
    }
    setSession(reply, { uid: u.id, tid: u.tenant_id, role: u.role });
    return { ok: true };
  });

  app.get('/api/auth/options', async () => ({ allowSignup: config.allowSignup }));

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const user = await one('select id, name, email, role, tenant_id from users where id=$1', [req.user.uid]);
    if (!user) throw new HttpError(401, 'الحساب غير موجود');
    const tenant = user.tenant_id ? await one('select id, name, slug, timezone from tenants where id=$1', [user.tenant_id]) : null;
    const extension = user.tenant_id
      ? await one('select id, number, name from extensions where tenant_id=$1 and user_id=$2 order by number limit 1', [user.tenant_id, user.id])
      : null;
    return { user, tenant, extension, allowSignup: config.allowSignup };
  });

  app.post('/api/auth/password', { preHandler: requireUser }, async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(8).max(200) }).parse(req.body);
    const u = await one('select password_hash from users where id=$1', [req.user.uid]);
    if (!u || !(await checkPassword(body.current, u.password_hash))) throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    await one('update users set password_hash=$2 where id=$1', [req.user.uid, await hashPassword(body.next)]);
    return { ok: true };
  });
}
