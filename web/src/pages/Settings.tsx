import { useEffect, useState } from 'react';
import { api, type PhoneNumber } from '../api';
import { Copy, ErrorNote, PageHead, useAction, useLoad } from '../components/ui';

interface TenantSettings {
  name: string;
  timezone: string;
  record_calls: boolean;
  allow_international: boolean;
  allowed_country_codes: string[];
  outbound_caller_id: string | null;
  daily_outbound_minutes: number;
  webhook_url: string | null;
  webhook_secret: string;
}

export default function Settings() {
  const { data, error } = useLoad(() => api.get<TenantSettings>('/api/settings'));
  const numbers = useLoad(() => api.get<PhoneNumber[]>('/api/numbers'));
  const [f, setF] = useState<TenantSettings | null>(null);
  const [codes, setCodes] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useAction();
  useEffect(() => {
    if (data) {
      setF(data);
      setCodes(data.allowed_country_codes.join(', '));
    }
  }, [data]);
  if (!f) return <><PageHead title="الإعدادات" /><ErrorNote error={error} /></>;

  const submit = async () => {
    setSaved(false);
    const ok = await save.run(() =>
      api.patch('/api/settings', {
        name: f.name,
        timezone: f.timezone,
        record_calls: f.record_calls,
        allow_international: f.allow_international,
        allowed_country_codes: codes.split(/[\s,،]+/).map((c) => c.replace(/\D/g, '')).filter(Boolean),
        outbound_caller_id: f.outbound_caller_id || null,
        daily_outbound_minutes: f.daily_outbound_minutes,
        webhook_url: f.webhook_url || null,
      }),
    );
    if (ok) setSaved(true);
  };
  const rotate = async () => {
    if (!confirm('بنولّد مفتاح جديد، والنظام اللي يستقبل الإشعارات لازم يستخدم المفتاح الجديد. نكمل؟')) return;
    const r = await save.run(() => api.post<{ webhook_secret: string }>('/api/settings/webhook-secret'));
    if (r) setF({ ...f, webhook_secret: r.webhook_secret });
  };

  return (
    <>
      <PageHead title="الإعدادات" />
      <div className="section stack">
        <h2>الشركة</h2>
        <div className="grid-2">
          <label className="field">اسم الشركة<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><span className="hint">يظهر كاسم المتصل في المكالمات الصادرة إذا يدعمه جوال الطرف الثاني</span></label>
          <label className="field">المنطقة الزمنية<select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
            {['Asia/Riyadh', 'Asia/Dubai', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Qatar', 'Asia/Muscat', 'Africa/Cairo'].map((z) => <option key={z} value={z}>{z}</option>)}
          </select><span className="hint">تُستخدم لأوقات الدوام</span></label>
        </div>
      </div>

      <div className="section stack">
        <h2>المكالمات</h2>
        <label className="check"><input type="checkbox" checked={f.record_calls} onChange={(e) => setF({ ...f, record_calls: e.target.checked })} />
          <span>سجّل كل المكالمات اللي يتم الرد عليها<br /><span className="muted small">يفضّل تنبيه المتصلين في رسالة الترحيب إن المكالمات مسجلة.</span></span></label>
        <label className="field">الرقم اللي يظهر للطرف الثاني في المكالمات الصادرة
          <select value={f.outbound_caller_id ?? ''} onChange={(e) => setF({ ...f, outbound_caller_id: e.target.value || null })}>
            <option value="">اختر رقم (بدونه ما تطلع مكالمات خارجية)</option>
            {numbers.data?.map((n) => <option key={n.id} value={n.e164}>{n.e164}{n.label ? ` (${n.label})` : ''}</option>)}
          </select>
        </label>
      </div>

      <div className="section stack">
        <h2>الحماية من المكالمات المكلفة</h2>
        <div className="grid-2">
          <label className="field">رموز الدول المسموحة<input className="num" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="966" /><span className="hint">مفصولة بفاصلة. 966 هي السعودية</span></label>
          <label className="field">حد الدقائق الصادرة يومياً<input type="number" min={0} value={f.daily_outbound_minutes} onChange={(e) => setF({ ...f, daily_outbound_minutes: Number(e.target.value) })} /><span className="hint">يوقف الاتصال الخارجي إذا وصل الحد خلال 24 ساعة</span></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.allow_international} onChange={(e) => setF({ ...f, allow_international: e.target.checked })} />
          <span>اسمح بالاتصال الدولي لكل الدول<br /><span className="muted small">الأرقام المميزة والفضائية محجوبة دائماً حتى لو فعّلت هذا الخيار.</span></span></label>
      </div>

      <div className="section stack">
        <h2>ربط الأنظمة الأخرى</h2>
        <p className="muted small">نرسل إشعار لنظامك (CRM أو نظام الحجوزات) لما تبدأ مكالمة أو تنتهي أو يوصل بريد صوتي.</p>
        <label className="field">رابط استقبال الإشعارات (Webhook)<input dir="ltr" value={f.webhook_url ?? ''} onChange={(e) => setF({ ...f, webhook_url: e.target.value })} placeholder="https://example.com/pbx-events" /></label>
        <div className="small">مفتاح التوقيع: <span className="secret">{f.webhook_secret}</span> <Copy value={f.webhook_secret} /> <button className="btn quiet small" onClick={rotate}>مفتاح جديد</button></div>
        <p className="muted small">كل إشعار يحمل الترويسة X-CloudPBX-Signature وفيها HMAC-SHA256 للمحتوى بهذا المفتاح.</p>
      </div>

      <ErrorNote error={save.error} />
      {saved && <div className="alert ok" style={{ marginBottom: 12 }}>تم حفظ الإعدادات</div>}
      <button className="btn primary" onClick={submit} disabled={save.busy}>حفظ الإعدادات</button>
    </>
  );
}
