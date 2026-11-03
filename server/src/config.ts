import path from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

const dataDir = process.env.DATA_DIR ?? '/data';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: env('DATABASE_URL'),
  jwtSecret: env('JWT_SECRET'),
  /** Public base URL of the dashboard, e.g. https://pbx.example.com */
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  /** WebSocket URL the browser phone uses to reach Asterisk, e.g. wss://pbx.example.com/ws */
  sipWsUrl: process.env.SIP_WS_URL ?? 'ws://localhost:8088/ws',
  /** SIP domain/host shown to users for softphones and desk phones */
  sipDomain: process.env.SIP_DOMAIN ?? 'localhost',
  sipPort: Number(process.env.SIP_PORT ?? 5060),
  ari: {
    url: process.env.ARI_URL ?? 'http://127.0.0.1:8088/ari',
    user: process.env.ARI_USER ?? 'cloudpbx',
    password: env('ARI_PASSWORD'),
    app: 'cloudpbx',
  },
  /** Endpoint name of the carrier trunk in pjsip.conf (telnyx, or sim-carrier in tests) */
  trunkEndpoint: process.env.TRUNK_ENDPOINT ?? 'telnyx',
  /** Format of dialled numbers sent to the carrier: '+e164' or 'e164' */
  trunkNumberFormat: (process.env.TRUNK_NUMBER_FORMAT ?? '+e164') as '+e164' | 'e164',
  allowSignup: (process.env.ALLOW_SIGNUP ?? 'false') === 'true',
  superadminEmail: process.env.SUPERADMIN_EMAIL,
  superadminPassword: process.env.SUPERADMIN_PASSWORD,
  dataDir,
  soundsDir: process.env.SOUNDS_DIR ?? path.join(dataDir, 'sounds'),
  /** Where Asterisk writes recordings (shared volume): <AST_SPOOL_DIR>/recording */
  recordingsDir: process.env.RECORDINGS_DIR ?? '/var/spool/asterisk/recording',
  /** Built-in Arabic system prompts (beep, invalid option, ...) */
  promptsDir: process.env.PROMPTS_DIR ?? path.resolve(process.cwd(), '..', 'prompts'),
  webDistDir: process.env.WEB_DIST_DIR ?? path.resolve(process.cwd(), '..', 'web', 'dist'),
  secureCookies: (process.env.SECURE_COOKIES ?? (process.env.PUBLIC_URL?.startsWith('https') ? 'true' : 'false')) === 'true',
  voicemailMaxSeconds: Number(process.env.VOICEMAIL_MAX_SECONDS ?? 120),
};
