import fs from 'node:fs';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { ari } from './engine/ari.js';
import { COOKIE } from './lib/auth.js';
import { HttpError } from './lib/tenancy.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import integrationRoutes from './routes/integrations.js';
import mediaRoutes from './routes/media.js';
import pbxRoutes from './routes/pbx.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(jwt, { secret: config.jwtSecret, cookie: { cookieName: COOKIE, signed: false } });
  await app.register(rateLimit, { global: false });
  await app.register(multipart);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: 'validation', message: first ? `${first.path.join('.') || 'الطلب'}: ${first.message}` : 'بيانات غير صحيحة' });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: 'error', message: err.message });
    const status = (err as any).statusCode;
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message: 'محاولات كثيرة، حاول بعد قليل' });
    if (status && status < 500) return reply.code(status).send({ error: "error", message: (err as Error).message });
    req.log.error(err as Error);
    return reply.code(500).send({ error: 'server_error', message: 'صار خطأ في الخادم، حاول مرة ثانية' });
  });

  app.get('/healthz', async (_req, reply) => {
    const dbOk = await pool.query('select 1').then(
      () => true,
      () => false,
    );
    const ok = dbOk && ari.connected;
    return reply.code(ok ? 200 : 503).send({ ok, db: dbOk, asterisk: ari.connected });
  });

  await app.register(authRoutes);
  await app.register(pbxRoutes);
  await app.register(mediaRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);

  // Dashboard (built SPA). Unknown non-API paths fall back to index.html.
  if (fs.existsSync(config.webDistDir)) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'غير موجود' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
