import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, one } from './db.js';
import { ari } from './engine/ari.js';
import { startCallEngine } from './engine/calls.js';
import { syncAllExtensions } from './engine/provision.js';
import { hashPassword } from './lib/auth.js';
import { logger } from './lib/logger.js';

async function ensureSuperadmin() {
  if (!config.superadminEmail || !config.superadminPassword) return;
  const email = config.superadminEmail.toLowerCase();
  const existing = await one('select id from users where email=$1', [email]);
  if (existing) return;
  await one(`insert into users(tenant_id, name, email, password_hash, role) values (null, 'مدير المنصة', $1, $2, 'superadmin')`, [
    email,
    await hashPassword(config.superadminPassword),
  ]);
  logger.info({ email }, 'platform admin account created');
}

async function main() {
  await migrate();
  await ensureSuperadmin();

  startCallEngine();
  ari.on('connected', () => {
    syncAllExtensions().catch((e) => logger.error({ err: String(e) }, 'extension sync failed'));
  });
  ari.connect();

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async () => {
    ari.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  logger.error({ err: String(e), stack: e?.stack }, 'fatal');
  process.exit(1);
});
