import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SessionUser {
  uid: string;
  tid: string | null;
  role: 'owner' | 'admin' | 'agent' | 'superadmin';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

export const COOKIE = 'pbx_session';

export const hashPassword = (p: string) => bcrypt.hash(p, 11);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

/** URL-safe random secret (SIP passwords etc). */
export function randomSecret(len = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized', message: 'سجّل الدخول أولاً' });
  }
}

export async function requireTenantUser(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (!req.user.tid) return reply.code(403).send({ error: 'forbidden', message: 'هذا الحساب غير مرتبط بشركة' });
}

export async function requireTenantAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireTenantUser(req, reply);
  if (reply.sent) return;
  if (!['owner', 'admin'].includes(req.user.role)) return reply.code(403).send({ error: 'forbidden', message: 'هذه العملية للمدير فقط' });
}

export async function requireSuperadmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (req.user.role !== 'superadmin') return reply.code(403).send({ error: 'forbidden', message: 'لمدير المنصة فقط' });
}
