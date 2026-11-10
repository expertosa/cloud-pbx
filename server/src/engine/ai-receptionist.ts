import type { Destination, HumanDestination } from '../lib/types.js';
import { aiReceptionistSettings } from '../config.js';

/**
 * Media format sent to Asterisk.
 *
 * Ubuntu 24.04 ships Asterisk 20.6.0 (asterisk + asterisk-modules). That build
 * includes chan_audiosocket, res_audiosocket and res_ari_channels, and ARI
 * externalMedia accepts encapsulation=audiosocket with transport=tcp.
 * res_audiosocket.c still hardcodes the wire format: kind 0x10 is "16-bit,
 * 8 kHz signed linear mono", and received frames are tagged ast_format_slin.
 * Asking for slin16 would play at the wrong speed. connection_type is ignored
 * for AudioSocket in this version: Asterisk always dials out to external_host.
 */
export const AI_MEDIA_FORMAT = 'slin' as const;

export type AiPhase = 'idle' | 'connecting' | 'up' | 'detaching' | 'closed';

export interface ExternalMediaRequest {
  app: string;
  external_host: string;
  encapsulation: 'audiosocket';
  transport: 'tcp';
  connection_type: 'client';
  format: typeof AI_MEDIA_FORMAT;
  direction: 'both';
  /** UUID Asterisk sends as the first AudioSocket message. The call session id. */
  data: string;
  channelId: string;
}

const SUMMARY_MAX = 160;

export function isPrivateMediaHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return false;
  const a = oct[0]!;
  const b = oct[1]!;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function mediaHostPort(host: string, port: number): string {
  const h = host.trim();
  return h.includes(':') ? `[${h.replace(/^\[|\]$/g, '')}]:${port}` : `${h}:${port}`;
}

/** Strip characters that would break a SIP header or a dialplan Set(). */
export function sanitizeHeaderText(value: string | undefined, max = SUMMARY_MAX): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Caller-id for the ringing leg.
 * A real number keeps a leading + and its digits (`+966 50 123 4567` → `+966501234567`).
 * A non-numeric test id (`sipp`, `anonymous`) is kept as a SIP token instead of
 * being replaced with the word "unknown". Empty stays empty so the dialplan
 * does not overwrite a caller id Asterisk already has.
 */
export function sanitizeCallerNumber(value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'unknown') return '';
  const compact = raw.replace(/[\s().-]/g, '');
  if (/^\+?\d+$/.test(compact)) {
    const digits = compact.replace(/\D/g, '');
    if (!digits) return '';
    return compact.startsWith('+') ? `+${digits}` : digits;
  }
  return raw.replace(/[^A-Za-z0-9*#+._-]/g, '').slice(0, 40);
}

export interface HandoffContext {
  callId: string;
  summary: string;
  callerName: string;
  callerNumber: string;
  timeoutSec: number;
}

/**
 * Rewrite a direct PJSIP endpoint into the receptionist-handoff Local channel.
 * The dialplan imports these variables onto the ;2 side and adds the SIP headers
 * before the INVITE. Returns null for trunk-style endpoints (user@trunk).
 */
export function handoffOriginate(
  endpoint: string,
  ctx: HandoffContext,
): { endpoint: string; variables: Record<string, string> } | null {
  if (!endpoint.startsWith('PJSIP/') || endpoint.includes('@')) return null;
  const user = endpoint.slice('PJSIP/'.length);
  if (!/^[A-Za-z0-9_-]+$/.test(user)) return null;
  return {
    endpoint: `Local/${user}@receptionist-handoff/n`,
    variables: {
      RECEPTIONIST_CALL: ctx.callId,
      RECEPTIONIST_SUMMARY: sanitizeHeaderText(ctx.summary),
      RECEPTIONIST_CID_NAME: sanitizeHeaderText(ctx.callerName, 40) || sanitizeCallerNumber(ctx.callerNumber),
      RECEPTIONIST_CID_NUM: sanitizeCallerNumber(ctx.callerNumber),
      RECEPTIONIST_TIMEOUT: String(ctx.timeoutSec),
    },
  };
}

export function fallbackDestination(dest: Destination): HumanDestination {
  if (dest.type === 'ai_receptionist' && dest.fallback) return dest.fallback;
  return { type: 'hangup' };
}

export type MediaPlan =
  | { ok: true; channelId: string; request: ExternalMediaRequest }
  | { ok: false; reason: 'disabled' | 'bad_port' | 'public_host' | 'busy' };

/**
 * Decide whether this call may attach external media.
 * Anything other than ok means the engine must run the fallback destination
 * and leave the caller on the line.
 */
export function planExternalMedia(sessionId: string, app: string, settings = aiReceptionistSettings()): MediaPlan {
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) return { ok: false, reason: 'bad_port' };
  if (!isPrivateMediaHost(settings.host)) return { ok: false, reason: 'public_host' };
  const channelId = `ai-${sessionId}`;
  return {
    ok: true,
    channelId,
    request: {
      app,
      external_host: mediaHostPort(settings.host, settings.port),
      encapsulation: 'audiosocket',
      transport: 'tcp',
      connection_type: 'client',
      format: AI_MEDIA_FORMAT,
      direction: 'both',
      data: sessionId,
      channelId,
    },
  };
}

/**
 * Per-call phase for the external-media leg. The engine performs the ARI
 * calls; this object only decides what is allowed so the transfer flow can
 * be tested without Asterisk.
 */
export class AiSession {
  phase: AiPhase = 'idle';
  channelId?: string;
  fallback: HumanDestination = { type: 'hangup' };
  hops = 0;

  begin(sessionId: string, fallback: HumanDestination, hops: number, app: string, settings = aiReceptionistSettings()): MediaPlan {
    if (this.phase !== 'idle') return { ok: false, reason: 'busy' };
    const plan = planExternalMedia(sessionId, app, settings);
    if (!plan.ok) return plan;
    this.phase = 'connecting';
    this.channelId = plan.channelId;
    this.fallback = fallback;
    this.hops = hops;
    return plan;
  }

  markUp(): void {
    if (this.phase === 'connecting') this.phase = 'up';
  }

  /** ARI rejected the externalMedia channel (host unreachable, bad format, ...). */
  connectFailed(): HumanDestination {
    const fallback = this.fallback;
    this.phase = 'closed';
    this.channelId = undefined;
    return fallback;
  }

  /** The AudioSocket peer hung up before a transfer. */
  mediaEnded(): { action: 'fallback'; destination: HumanDestination } | { action: 'ignore' } {
    if (this.phase !== 'up' && this.phase !== 'connecting') return { action: 'ignore' };
    const destination = this.fallback;
    this.phase = 'closed';
    this.channelId = undefined;
    return { action: 'fallback', destination };
  }

  requestControl(): { ok: true } | { ok: false } {
    if (this.phase !== 'up' && this.phase !== 'connecting') return { ok: false };
    this.phase = 'detaching';
    return { ok: true };
  }

  finish(): void {
    this.phase = 'closed';
    this.channelId = undefined;
  }
}

export function evaluateLiveControl(
  session: { tenantId: string; phase: AiPhase } | null,
  tokenTenantId: string,
): { ok: true } | { ok: false; status: 404 | 409; message: string } {
  if (!session || session.tenantId !== tokenTenantId) {
    return { ok: false, status: 404, message: 'المكالمة غير موجودة' };
  }
  if (session.phase !== 'up' && session.phase !== 'connecting') {
    return { ok: false, status: 409, message: 'المكالمة ليست مع الموظف الذكي' };
  }
  return { ok: true };
}
