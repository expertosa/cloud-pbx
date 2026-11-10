import { describe, expect, it } from 'vitest';
import { callOutcome } from '../src/lib/call-outcome.js';

describe('call outcome', () => {
  const now = Date.parse('2026-11-10T18:00:40Z');

  it('leaves an unanswered inbound call missed, with no talk time', () => {
    expect(callOutcome({ status: 'ringing', direction: 'inbound', now })).toEqual({ status: 'missed', duration_s: null });
    expect(callOutcome({ status: 'ringing', direction: 'outbound', now }).status).toBe('abandoned');
  });

  it('closes a call that is still with the receptionist as answered, from when the AI picked up', () => {
    const answeredAt = new Date(now - 65_400);
    expect(callOutcome({ status: 'ai', direction: 'inbound', answeredAt, now })).toEqual({ status: 'answered', duration_s: 65 });
  });

  it('keeps a human answer and its own clock', () => {
    const answeredAt = new Date(now - 12_000);
    expect(callOutcome({ status: 'answered', direction: 'inbound', answeredAt, now })).toEqual({ status: 'answered', duration_s: 12 });
    expect(callOutcome({ status: 'voicemail', direction: 'inbound', now })).toEqual({ status: 'voicemail', duration_s: null });
  });
});
