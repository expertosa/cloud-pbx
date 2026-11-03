import { describe, expect, it } from 'vitest';
import { isAllowedDestination, isBlockedPremium, normalizeDialed, normalizeDid } from '../src/lib/phone.js';
import { isOpen } from '../src/lib/hours.js';

describe('normalizeDialed', () => {
  it('handles Saudi formats', () => {
    expect(normalizeDialed('0501234567')).toBe('+966501234567');
    expect(normalizeDialed('050 123 4567')).toBe('+966501234567');
    expect(normalizeDialed('011234567')).toBe('+96611234567');
    expect(normalizeDialed('+966501234567')).toBe('+966501234567');
    expect(normalizeDialed('00966501234567')).toBe('+966501234567');
    expect(normalizeDialed('920012345')).toBe('+966920012345');
    expect(normalizeDialed('8001234567')).toBe('+9668001234567');
  });
  it('rejects short internal-looking numbers', () => {
    expect(normalizeDialed('101')).toBeNull();
    expect(normalizeDialed('*97')).toBeNull();
    expect(normalizeDialed('')).toBeNull();
  });
});

describe('normalizeDid', () => {
  it('accepts carrier formats', () => {
    expect(normalizeDid('+15550001111')).toBe('+15550001111');
    expect(normalizeDid('15550001111')).toBe('+15550001111');
    expect(normalizeDid('sip:+15550001111@sip.telnyx.com')).toBe('+15550001111');
    expect(normalizeDid('s')).toBeNull();
  });
});

describe('outbound policy', () => {
  it('allows listed country codes only', () => {
    expect(isAllowedDestination('+966501234567', ['966'])).toBe(true);
    expect(isAllowedDestination('+447700900123', ['966'])).toBe(false);
  });
  it('blocks premium ranges', () => {
    expect(isBlockedPremium('+9667001234')).toBe(true);
    expect(isBlockedPremium('+966920012345')).toBe(false);
    expect(isBlockedPremium('+966501234567')).toBe(false);
    expect(isBlockedPremium('+881612345678')).toBe(true);
  });
});

describe('business hours', () => {
  const hours = { '0': [['08:00', '17:00']] as [string, string][] }; // Sunday only
  it('is open inside the window (Riyadh time)', () => {
    // Sunday 2026-11-01 10:00 Riyadh = 07:00 UTC
    expect(isOpen(hours, 'Asia/Riyadh', new Date('2026-11-01T07:00:00Z'))).toBe(true);
  });
  it('is closed outside the window', () => {
    expect(isOpen(hours, 'Asia/Riyadh', new Date('2026-11-01T15:00:00Z'))).toBe(false); // 18:00
    expect(isOpen(hours, 'Asia/Riyadh', new Date('2026-11-02T07:00:00Z'))).toBe(false); // Monday
  });
  it('treats no schedule as always open', () => {
    expect(isOpen(null, 'Asia/Riyadh')).toBe(true);
  });
});
