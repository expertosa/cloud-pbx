import { useState } from 'react';
import { api, type Call } from '../api';
import { directionLabel, duration, phone, statusLabel, when } from '../format';
import { ErrorNote, PageHead, useLoad } from '../components/ui';

function party(c: Call) {
  if (c.direction === 'inbound') return { primary: c.from_name && c.from_name !== c.from_number ? c.from_name : phone(c.from_number), secondary: c.from_name && c.from_name !== c.from_number ? phone(c.from_number) : null };
  if (c.direction === 'outbound') return { primary: phone(c.to_number), secondary: c.ext_name ? `من ${c.ext_name}` : null };
  return { primary: `${c.ext_name ?? c.from_number} ← ${c.to_number}`, secondary: null };
}

export function CallsTable({ calls }: { calls: Call[] }) {
  const [playing, setPlaying] = useState<string | null>(null);
  if (calls.length === 0) return <div className="empty">ما فيه مكالمات بعد. أول مكالمة على رقمك بتظهر هنا.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>المتصل / الرقم</th>
            <th>الحالة</th>
            <th className="hide-sm">رد عليها</th>
            <th className="hide-sm">الوقت</th>
            <th>المدة</th>
            <th aria-label="التسجيل" />
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => {
            const p = party(c);
            return (
              <tr key={c.id}>
                <td>
                  <div className={/^[\d+]/.test(p.primary) ? 'ltr' : ''} style={{ fontWeight: 500 }}>{p.primary}</div>
                  <div className="dir">{directionLabel[c.direction]}{p.secondary ? `، ${p.secondary}` : ''}</div>
                </td>
                <td>
                  <span className={`status s-${c.status}`}>{statusLabel[c.status] ?? c.status}</span>
                  {c.handled_by_ai && c.status !== 'ai' && <div className="muted small">عبر الموظف الذكي</div>}
                </td>
                <td className="hide-sm">{c.answered_name ? `${c.answered_name} (${c.answered_number})` : '—'}</td>
                <td className="hide-sm muted">{when(c.started_at)}</td>
                <td className="num">{duration(c.duration_s)}</td>
                <td>
                  {c.has_recording &&
                    (playing === c.id ? (
                      <audio src={`/api/calls/${c.id}/recording`} controls autoPlay />
                    ) : (
                      <button className="btn quiet small" onClick={() => setPlaying(c.id)} aria-label="تشغيل التسجيل">▶ استماع</button>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Calls() {
  const [filter, setFilter] = useState({ direction: '', status: '', search: '', page: 1 });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== '' && v !== 0).map(([k, v]) => [k, String(v)]));
  const { data, error, loading } = useLoad(() => api.get<Call[]>(`/api/calls?${qs}`), [qs.toString()]);
  const set = (k: string, v: string | number) => setFilter({ ...filter, [k]: v, page: k === 'page' ? Number(v) : 1 });

  return (
    <>
      <PageHead title="سجل المكالمات" intro="كل المكالمات الواردة والصادرة والداخلية، مع التسجيلات إذا كان التسجيل مفعّل." />
      <div className="section">
        <div className="row" style={{ marginBottom: 14 }}>
          <input className="grow" style={{ maxWidth: 260 }} placeholder="ابحث برقم أو اسم" value={filter.search} onChange={(e) => set('search', e.target.value)} aria-label="بحث" />
          <select style={{ width: 'auto' }} value={filter.direction} onChange={(e) => set('direction', e.target.value)} aria-label="الاتجاه">
            <option value="">كل الاتجاهات</option>
            <option value="inbound">واردة</option>
            <option value="outbound">صادرة</option>
            <option value="internal">داخلية</option>
          </select>
          <select style={{ width: 'auto' }} value={filter.status} onChange={(e) => set('status', e.target.value)} aria-label="الحالة">
            <option value="">كل الحالات</option>
            <option value="answered">تم الرد</option>
            <option value="missed">فائتة</option>
            <option value="voicemail">بريد صوتي</option>
            <option value="failed">لم تكتمل</option>
            <option value="rejected">محجوبة</option>
            <option value="ai">الموظف الذكي</option>
          </select>
        </div>
        <ErrorNote error={error} />
        {data && <CallsTable calls={data} />}
        {!loading && data && (filter.page > 1 || data.length === 50) && (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" disabled={filter.page <= 1} onClick={() => set('page', filter.page - 1)}>الأحدث</button>
            <span className="muted small">صفحة {filter.page}</span>
            <button className="btn" disabled={data.length < 50} onClick={() => set('page', filter.page + 1)}>الأقدم</button>
          </div>
        )}
      </div>
    </>
  );
}
