const dateFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('ar-SA-u-nu-latn-ca-gregory', { hour: 'numeric', minute: '2-digit' });

export function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `اليوم ${timeFmt.format(d)}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `أمس ${timeFmt.format(d)}`;
  return dateFmt.format(d);
}

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** +966501234567 -> 050 123 4567 ; other countries keep E.164 with spaces */
export function phone(n: string | null | undefined): string {
  if (!n) return 'غير معروف';
  const m = n.match(/^\+?966(5\d)(\d{3})(\d{4})$/);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  return n;
}

export const statusLabel: Record<string, string> = {
  answered: 'تم الرد',
  missed: 'فائتة',
  voicemail: 'بريد صوتي',
  ringing: 'جارية',
  failed: 'لم تكتمل',
  rejected: 'محجوبة',
  abandoned: 'أُلغيت',
};

export const directionLabel: Record<string, string> = {
  inbound: 'واردة',
  outbound: 'صادرة',
  internal: 'داخلية',
};

export const dayNames = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
