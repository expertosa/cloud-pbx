/**
 * Business hours: { "0": [["08:00","17:00"]], "1": [...], ... } keyed by weekday (0 = Sunday).
 * Returns whether `now` falls inside an open window, in the tenant's time zone.
 */
export type BusinessHours = Record<string, [string, string][]>;

export function isOpen(hours: BusinessHours | null | undefined, timeZone: string, now = new Date()): boolean {
  if (!hours) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const cur = `${hh}:${mm}`;
  const windows = hours[String(day)] ?? [];
  return windows.some(([from, to]) => (from <= to ? cur >= from && cur < to : cur >= from || cur < to));
}
