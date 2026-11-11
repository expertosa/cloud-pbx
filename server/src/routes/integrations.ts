import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hangupLiveCall, transferLiveCall } from '../engine/calls.js';
import { requireIntegration, requireIntegrationTenant } from '../lib/integration-auth.js';
import { assertDestination } from '../lib/tenancy.js';
import { humanDestinationSchema } from '../lib/types.js';

const idParam = z.object({ id: z.uuid() });

/**
 * Called by the external receptionist with a per-tenant service token.
 * Transfer detaches the AudioSocket channel and rings the chosen destination.
 */
export default async function integrationRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireIntegration, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/api/integrations/calls/:id/transfer', guard, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        destination: humanDestinationSchema,
        summary: z.string().trim().max(500).optional(),
        external_ref: z.string().trim().min(1).max(200).optional(),
      })
      .parse(req.body);
    const auth = requireIntegrationTenant(req);
    await assertDestination(auth.tenantId, body.destination);
    return transferLiveCall(id, auth.tenantId, {
      destination: body.destination,
      summary: body.summary,
      externalRef: body.external_ref,
    });
  });

  app.post('/api/integrations/calls/:id/hangup', guard, async (req) => {
    const { id } = idParam.parse(req.params);
    const auth = requireIntegrationTenant(req);
    return hangupLiveCall(id, auth.tenantId);
  });
}
