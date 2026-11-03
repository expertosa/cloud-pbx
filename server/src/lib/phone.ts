/**
 * Phone-number helpers, Saudi-first.
 * normalizeDialed turns what a user types on a phone into E.164 ("+9665…"),
 * or returns null when it is not an external number.
 */
export function normalizeDialed(raw: string): string | null {
  let s = raw.replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (/^05\d{8}$/.test(s)) s = '966' + s.slice(1); // Saudi mobile 05XXXXXXXX
  else if (/^01\d{7}$/.test(s)) s = '966' + s.slice(1); // Saudi landline 01X XXXXXXX
  else if (/^0[2-7]\d{7}$/.test(s)) s = '966' + s.slice(1);
  else if (/^(800|920)\d{6,7}$/.test(s)) s = '966' + s; // 800 / 9200 numbers
  else if (/^5\d{8}$/.test(s)) s = '966' + s;
  else if (!/^\d{11,15}$/.test(s)) return null;
  if (!/^[1-9]\d{6,14}$/.test(s)) return null;
  return '+' + s;
}

/** Normalise a DID as received from the carrier ("+1555…", "1555…", "sip:+1555@…") to E.164. */
export function normalizeDid(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const m = s.match(/^(?:sips?:)?([^@;]+)/);
  if (m) s = m[1];
  s = s.replace(/[^\d+]/g, '');
  if (!s) return null;
  if (!s.startsWith('+')) s = '+' + s.replace(/^00/, '');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** True when the E.164 number starts with one of the allowed country-code prefixes. */
export function isAllowedDestination(e164: string, allowedPrefixes: string[]): boolean {
  const digits = e164.replace(/^\+/, '');
  return allowedPrefixes.some((p) => p && digits.startsWith(p.replace(/^\+/, '')));
}

/** Premium-rate / high-fraud prefixes that are never dialled, whatever the tenant settings. */
const BLOCKED_PREFIXES = ['900', '881', '882', '883', '979', '808', '870', '871', '872', '873', '874'];
export function isBlockedPremium(e164: string): boolean {
  const d = e164.replace(/^\+/, '');
  if (d.startsWith('966700')) return true; // Saudi premium-rate 700
  if (/^9669\d{2}/.test(d) && !d.startsWith('966920')) return true; // Saudi 9xx short/premium (9200 is allowed)
  return BLOCKED_PREFIXES.some((p) => d.startsWith(p));
}
