import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { destinationSchema, humanDestinationSchema } from '../src/lib/types.js';
import {
  AiSession,
  evaluateLiveControl,
  fallbackDestination,
  handoffOriginate,
  isPrivateMediaHost,
  planExternalMedia,
  sanitizeCallerNumber,
  sanitizeHeaderText,
} from '../src/engine/ai-receptionist.js';

const settings = { enabled: true, host: '127.0.0.1', port: 9092 };
const callId = '11111111-1111-4111-8111-111111111111';

describe('destination schema', () => {
  it('accepts the receptionist with a human fallback and rejects nesting', () => {
    const parsed = destinationSchema.parse({
      type: 'ai_receptionist',
      fallback: { type: 'voicemail', id: callId },
    });
    expect(parsed).toEqual({ type: 'ai_receptionist', fallback: { type: 'voicemail', id: callId } });
    expect(destinationSchema.parse({ type: 'ai_receptionist' })).toEqual({ type: 'ai_receptionist' });
    expect(humanDestinationSchema.safeParse({ type: 'ai_receptionist' }).success).toBe(false);
    expect(destinationSchema.safeParse({ type: 'ai_receptionist', fallback: { type: 'ai_receptionist' } }).success).toBe(false);
  });
});

describe('media target', () => {
  it('allows only loopback and private addresses', () => {
    expect(isPrivateMediaHost('127.0.0.1')).toBe(true);
    expect(isPrivateMediaHost('localhost')).toBe(true);
    expect(isPrivateMediaHost('10.1.2.3')).toBe(true);
    expect(isPrivateMediaHost('192.168.0.8')).toBe(true);
    expect(isPrivateMediaHost('172.16.0.1')).toBe(true);
    expect(isPrivateMediaHost('172.31.255.255')).toBe(true);
    expect(isPrivateMediaHost('::1')).toBe(true);
    expect(isPrivateMediaHost('172.32.0.1')).toBe(false);
    expect(isPrivateMediaHost('8.8.8.8')).toBe(false);
    expect(isPrivateMediaHost('receptionist.example.com')).toBe(false);
    expect(isPrivateMediaHost('0.0.0.0')).toBe(false);
  });

  it('plans an AudioSocket slin channel correlated with the call id', () => {
    const plan = planExternalMedia(callId, 'cloudpbx', settings);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.channelId).toBe(`ai-${callId}`);
    expect(plan.request).toMatchObject({
      app: 'cloudpbx',
      external_host: '127.0.0.1:9092',
      encapsulation: 'audiosocket',
      transport: 'tcp',
      connection_type: 'client',
      format: 'slin',
      direction: 'both',
      data: callId,
      channelId: `ai-${callId}`,
    });
  });

  it('fails closed when the feature is off or the host is public', () => {
    expect(planExternalMedia(callId, 'cloudpbx', { ...settings, enabled: false })).toEqual({ ok: false, reason: 'disabled' });
    expect(planExternalMedia(callId, 'cloudpbx', { ...settings, host: '8.8.8.8' }).ok).toBe(false);
    expect(planExternalMedia(callId, 'cloudpbx', { ...settings, port: 0 }).ok).toBe(false);
    expect(fallbackDestination({ type: 'ai_receptionist', fallback: { type: 'hangup' } })).toEqual({ type: 'hangup' });
    expect(fallbackDestination({ type: 'ai_receptionist' })).toEqual({ type: 'hangup' });
  });
});

describe('AiSession transfer flow', () => {
  it('falls back when media cannot be attached, and transfers only once', () => {
    const ai = new AiSession();
    const fallback = { type: 'ring_group' as const, id: callId };
    const plan = ai.begin(callId, fallback, 1, 'cloudpbx', settings);
    expect(plan.ok).toBe(true);
    expect(ai.connectFailed()).toEqual(fallback);
    expect(ai.phase).toBe('closed');
    expect(evaluateLiveControl({ tenantId: 't1', phase: ai.phase }, 't1')).toMatchObject({ ok: false, status: 409 });

    const live = new AiSession();
    live.begin(callId, fallback, 2, 'cloudpbx', settings);
    live.markUp();
    expect(evaluateLiveControl(null, 't1')).toMatchObject({ status: 404 });
    expect(evaluateLiveControl({ tenantId: 't1', phase: 'up' }, 'other')).toMatchObject({ status: 404 });
    expect(live.requestControl().ok).toBe(true);
    expect(live.requestControl().ok).toBe(false);
    expect(live.mediaEnded()).toEqual({ action: 'ignore' });
  });

  it('treats a dropped socket before transfer as a fallback', () => {
    const ai = new AiSession();
    ai.begin(callId, { type: 'voicemail', id: callId }, 0, 'cloudpbx', settings);
    ai.markUp();
    expect(ai.mediaEnded()).toEqual({ action: 'fallback', destination: { type: 'voicemail', id: callId } });
  });
});

describe('handoff legs', () => {
  it('rewrites extension endpoints and keeps caller context in channel variables', () => {
    const handed = handoffOriginate('PJSIP/acme101', {
      callId,
      summary: 'العميل يسأل\nعن الفاتورة',
      callerName: 'Sara "A"',
      callerNumber: '+966501234567',
      timeoutSec: 25,
    });
    expect(handed?.endpoint).toBe('Local/acme101@receptionist-handoff/n');
    expect(handed?.variables.RECEPTIONIST_CALL).toBe(callId);
    expect(handed?.variables.RECEPTIONIST_SUMMARY).toBe('العميل يسأل عن الفاتورة');
    expect(handed?.variables.RECEPTIONIST_CID_NAME).toBe('Sara A');
    expect(handed?.variables.RECEPTIONIST_CID_NUM).toBe('+966501234567');
    expect(handed?.variables.RECEPTIONIST_TIMEOUT).toBe('25');
    const named = handoffOriginate('PJSIP/acme101', {
      callId,
      summary: '',
      callerName: 'SIPp',
      callerNumber: 'sipp',
      timeoutSec: 25,
    });
    expect(named?.variables.RECEPTIONIST_CID_NUM).toBe('sipp');
    expect(named?.variables.RECEPTIONIST_CID_NAME).toBe('SIPp');
    expect(sanitizeCallerNumber('+966 50 123 4567')).toBe('+966501234567');
    expect(sanitizeCallerNumber('anonymous')).toBe('anonymous');
    expect(sanitizeCallerNumber('unknown')).toBe('');
    expect(sanitizeCallerNumber('')).toBe('');
    expect(handoffOriginate('PJSIP/966501234567@telnyx', { callId, summary: '', callerName: '', callerNumber: '', timeoutSec: 25 })).toBeNull();
    expect(sanitizeHeaderText('a'.repeat(400)).length).toBe(160);
  });

  it('matches the dialplan that adds the SIP headers', () => {
    const conf = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../asterisk/etc/extensions.conf'), 'utf8');
    expect(conf).toContain('[receptionist-handoff]');
    expect(conf).toContain('[receptionist-predial]');
    expect(conf).toContain('X-Receptionist-Call');
    expect(conf).toContain('X-Receptionist-Summary');
    expect(conf).toContain('IMPORT(${PEER},RECEPTIONIST_CALL)');
    expect(conf).toContain('b(receptionist-predial^s^1)');
  });
});
