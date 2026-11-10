import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { aiReceptionistSettings } from '../config.js';
import { one, q } from '../db.js';
import { HttpError } from './tenancy.js';
import type { Tenant } from './types.js';

export interface IntegrationAuth {
  integrationId: string;
  tenantId: string;
  tenant: Pick<Tenant, 'id' | 'name' | 'slug' | 'webhook_url' | 'webhook_secret' | 'disabled'>;
}

declare module 'fastify' {
  interface FastifyRequest {
    integration?: IntegrationAuth;
  }
}

/** SHA-256 hex of the full bearer token. Only this hash is stored. */
export function hashServiceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateServiceToken(): string {
  return `pbx_${crypto.randomBytes(32).toString('base64url')}`;
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!;
  if (token.length < 20 || token.length > 200) return null;
  return token;
}

/**
 * Service-token auth for the receptionist integration. The token is scoped to
 * one tenant via tenant_integrations.tenant_id. Disabled feature → 404 so the
 * route does not exist for installs that have not turned it on.
 */
export async function requireIntegration(req: FastifyRequest, reply: FastifyReply) {
  if (!aiReceptionistSettings().enabled) {
    return reply.code(404).send({ error: 'not_found', message: 'غير موجود' });
  }
  const token = parseBearer(req.headers.authorization);
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'رمز الخدمة مطلوب' });
  }
  const row = await one<{
    integration_id: string;
    tenant_id: string;
    name: string;
    slug: string;
    webhook_url: string | null;
    webhook_secret: string;
    disabled: boolean;
  }>(
    `select i.id as integration_id, i.tenant_id, t.name, t.slug, t.webhook_url, t.webhook_secret, t.disabled
     from tenant_integrations i
     join tenants t on t.id = i.tenant_id
     where i.token_hash = $1 and i.revoked_at is null`,
    [hashServiceToken(token)],
  );
  if (!row || row.disabled) {
    return reply.code(401).send({ error: 'unauthorized', message: 'رمز الخدمة غير صالح' });
  }
  req.integration = {
    integrationId: row.integration_id,
    tenantId: row.tenant_id,
    tenant: {
      id: row.tenant_id,
      name: row.name,
      slug: row.slug,
      webhook_url: row.webhook_url,
      webhook_secret: row.webhook_secret,
      disabled: row.disabled,
    },
  };
  void Promise.resolve(q('update tenant_integrations set last_used_at = now() where id = $1', [row.integration_id])).catch(() => {});
}

export function requireIntegrationTenant(req: FastifyRequest): IntegrationAuth {
  if (!req.integration) throw new HttpError(401, 'رمز الخدمة مطلوب');
  return req.integration;
}
