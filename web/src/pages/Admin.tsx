import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, Modal, PageHead, useAction, useLoad } from '../components/ui';
import { when } from '../format';

interface T { id: string; name: string; slug: string; disabled: boolean; created_at: string; extensions: number; numbers: number; calls_30d: number; owner_email: string }
interface N { id: string; e164: string; label: string | null; tenant_id: string | null; tenant_name: string | null }
interface N { id: string; e164: string; label: string | null; tenant_id: string | null; tenant_name: string | null }

interface TelnyxBalance {
  configured: boolean;
  ok: boolean;
  message?: string;
  balance?: string;
  available_credit?: string;
  credit_limit?: string;
  pending?: string;
  currency?: string;
  fetched_at?: string;
  low?: boolean;
  threshold?: number;
  topup_url: string;
}

const TELNYX_BILLING_URL = 'https://portal.telnyx.com/#/billing/payment';

function money(amount: string | undefined, currency: string | undefined): string {
  if (!amount) return '—';
  return currency ? `${amount} ${currency}` : amount;
}

function TelnyxBalanceCard() {
  const balance = useLoad(() => api.get<TelnyxBalance>('/api/admin/telnyx-balance'));
  const data = balance.data;
  const topup = data?.topup_url || TELNYX_BILLING_URL;
  return (
    <div className="section">
      <div className="section-head">
        <h2>رصيد Telnyx</h2>
        <div className="row">
          <button className="btn quiet small" onClick={balance.reload} type="button">تحديث</button>
          <a className="btn primary" href={topup} target="_blank" rel="noopener noreferrer">إضافة رصيد</a>
        </div>
      </div>
      <ErrorNote error={balance.error} />
      {data && data.ok && (
        <>
          <div className="strip" style={{ marginBottom: data.low ? 14 : 0, gridTemplateColumns: '1.2fr 1fr 1fr' }}>
            <div>
              <div className={`v num ${data.low ? 'miss' : ''}`}>{money(data.available_credit, data.currency)}</div>
              <div className="k">الرصيد المتاح</div>
            </div>
            <div>
              <div className="v num" style={{ fontSize: 'var(--fs-xl)' }}>{money(data.balance, data.currency)}</div>
              <div className="k">الرصيد</div>
            </div>
            <div>
              <div className="muted small">آخر تحديث</div>
              <div className="small">{data.fetched_at ? when(data.fetched_at) : '—'}</div>
            </div>
          </div>
          {data.low && (
            <div className="alert warn">الرصيد المتاح أقل من {money(String(data.threshold ?? 10), data.currency)}. شحن الحساب من لوحة Telnyx يجنّب انقطاع المكالمات.</div>
          )}
        </>
      )}
      {data && !data.ok && <p className="muted small">{data.message}</p>}
    </div>
  );
}


function NewTenant({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ company: '', name: '', email: '', password: '' });
  const { busy, error, run } = useAction();
  const save = async () => {
    if (await run(() => api.post('/api/admin/tenants', f))) {
      onDone();
      onClose();
    }
  };
  return (
    <Modal title="شركة جديدة" onClose={onClose}>
      <div className="stack">
        <label className="field">اسم الشركة<input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label>
        <label className="field">اسم المسؤول<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="grid-2">
          <label className="field">بريد المسؤول<input dir="ltr" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">كلمة مرور مؤقتة<input dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        </div>
        <p className="muted small">ننشئ للمسؤول تحويلة 101 تلقائياً.</p>
        <ErrorNote error={error} />
        <div className="modal-foot"><button className="btn primary" onClick={save} disabled={busy}>إنشاء</button><button className="btn quiet" onClick={onClose}>إلغاء</button></div>
      </div>
    </Modal>
  );
}

export default function Admin() {
  const status = useLoad(() => api.get('/api/admin/status'));
  const tenants = useLoad(() => api.get<T[]>('/api/admin/tenants'));
  const numbers = useLoad(() => api.get<N[]>('/api/admin/numbers'));
  const [adding, setAdding] = useState(false);
  const [num, setNum] = useState({ e164: '', tenant_id: '', label: '' });
  const act = useAction();
  const s = status.data;
  const trunkOk = s?.trunk?.state === 'online';

  const addNumber = async () => {
    const ok = await act.run(() => api.post('/api/admin/numbers', { e164: num.e164, tenant_id: num.tenant_id || null, label: num.label || undefined }));
    if (ok) {
      setNum({ e164: '', tenant_id: '', label: '' });
      void numbers.reload();
      void tenants.reload();
    }
  };
  const assign = async (n: N, tenant_id: string) => {
    if (n.tenant_id && !confirm('نقل الرقم يمسح مسار المكالمات الحالي له. نكمل؟')) return;
    if (await act.run(() => api.patch(`/api/admin/numbers/${n.id}`, { tenant_id: tenant_id || null }))) {
      void numbers.reload();
      void tenants.reload();
    }
  };
  const toggle = async (t: T) => {
    if (await act.run(() => api.patch(`/api/admin/tenants/${t.id}`, { disabled: !t.disabled }))) void tenants.reload();
  };

  return (
    <>
      <PageHead title="إدارة المنصة" intro="أضف الشركات واربط أرقام Telnyx بها." />
      <TelnyxBalanceCard />
      <div className="section">
        <div className="section-head"><h2>حالة النظام</h2><button className="btn quiet small" onClick={status.reload}>تحديث</button></div>
        <ErrorNote error={status.error} />
        {s && (
          <dl className="kv">
            <dt>محرك الصوت</dt><dd><span className={`status ${s.ari_connected ? 's-answered' : 's-missed'}`}>{s.ari_connected ? 'متصل' : 'غير متصل'}</span> <span className="muted small num">{s.asterisk?.version}</span></dd>
            <dt>خط الاتصال ({s.trunk?.endpoint})</dt><dd><span className={`status ${trunkOk ? 's-answered' : 's-missed'}`}>{trunkOk ? 'جاهز' : s.trunk?.state === 'missing' ? 'غير مُعد' : 'غير متاح'}</span></dd>
            <dt>مكالمات جارية</dt><dd className="num">{s.active_calls}</dd>
          </dl>
        )}
      </div>

      <div className="section">
        <div className="section-head"><h2>الشركات</h2><button className="btn primary" onClick={() => setAdding(true)}>شركة جديدة</button></div>
        <ErrorNote error={tenants.error ?? act.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>الشركة</th><th>المسؤول</th><th>تحويلات</th><th>أرقام</th><th>مكالمات 30 يوم</th><th className="hide-sm">أُنشئت</th><th /></tr></thead>
            <tbody>
              {tenants.data?.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 500 }}>{t.name}{t.disabled && <span className="status s-missed small"> موقوفة</span>}</td>
                  <td className="ltr small">{t.owner_email}</td>
                  <td className="num">{t.extensions}</td>
                  <td className="num">{t.numbers}</td>
                  <td className="num">{t.calls_30d}</td>
                  <td className="hide-sm muted small">{when(t.created_at)}</td>
                  <td><button className={`btn quiet small ${t.disabled ? '' : 'danger'}`} onClick={() => toggle(t)}>{t.disabled ? 'تفعيل' : 'إيقاف'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-head"><h2>أرقام Telnyx</h2></div>
        <p className="muted small" style={{ marginBottom: 14 }}>اشترِ الرقم من لوحة Telnyx واربطه بالـ SIP Connection، وبعدها أضفه هنا وحدد الشركة.</p>
        <div className="row" style={{ marginBottom: 14 }}>
          <input dir="ltr" style={{ maxWidth: 200 }} placeholder="+15551234567" value={num.e164} onChange={(e) => setNum({ ...num, e164: e.target.value })} aria-label="الرقم" />
          <input style={{ maxWidth: 180 }} placeholder="اسم (اختياري)" value={num.label} onChange={(e) => setNum({ ...num, label: e.target.value })} aria-label="الاسم" />
          <select style={{ width: 'auto' }} value={num.tenant_id} onChange={(e) => setNum({ ...num, tenant_id: e.target.value })} aria-label="الشركة">
            <option value="">بدون شركة</option>
            {tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn" onClick={addNumber} disabled={act.busy || !num.e164}>إضافة الرقم</button>
        </div>
        <table>
          <tbody>
            {numbers.data?.map((n) => (
              <tr key={n.id}>
                <td className="ltr" style={{ fontWeight: 500 }}>{n.e164}</td>
                <td className="small">{n.label}</td>
                <td>
                  <select value={n.tenant_id ?? ''} onChange={(e) => assign(n, e.target.value)} aria-label="الشركة">
                    <option value="">بدون شركة</option>
                    {tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <NewTenant onClose={() => setAdding(false)} onDone={tenants.reload} />}
    </>
  );
}
