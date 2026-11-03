import { useState } from 'react';
import { api, type Destination, type PhoneNumber } from '../api';
import { DestinationPicker, destinationLabel, useDirectory } from '../components/directory';
import { ErrorNote, PageHead, useAction, useLoad } from '../components/ui';
import { dayNames } from '../format';

type Hours = Record<string, [string, string][]>;
const DEFAULT_HOURS: Hours = { '0': [['08:00', '17:00']], '1': [['08:00', '17:00']], '2': [['08:00', '17:00']], '3': [['08:00', '17:00']], '4': [['08:00', '17:00']] };

function hoursSummary(h: Hours) {
  const open = Object.keys(h).filter((d) => h[d]?.length).map(Number).sort();
  if (!open.length) return 'مغلق كل الأيام';
  const first = h[String(open[0])][0];
  return `${open.map((d) => dayNames[d]).join('، ')} من ${first[0]} إلى ${first[1]}`;
}

function NumberCard({ n, onSaved }: { n: PhoneNumber; onSaved: () => void }) {
  const dir = useDirectory();
  const [edit, setEdit] = useState(false);
  const [dest, setDest] = useState<Destination>(n.destination);
  const [useHours, setUseHours] = useState(Boolean(n.business_hours && n.after_hours_dest));
  const [hours, setHours] = useState<Hours>(n.business_hours ?? DEFAULT_HOURS);
  const [after, setAfter] = useState<Destination>(
    n.after_hours_dest ?? (dir.extensions[0] ? { type: 'voicemail', id: dir.extensions[0].id } : { type: 'hangup' }),
  );
  const [label, setLabel] = useState(n.label ?? '');
  const { busy, error, run } = useAction();

  const save = async () => {
    const ok = await run(() =>
      api.patch(`/api/numbers/${n.id}`, {
        label: label || null,
        destination: dest,
        business_hours: useHours ? hours : null,
        after_hours_dest: useHours ? after : null,
      }),
    );
    if (ok) {
      setEdit(false);
      onSaved();
    }
  };

  const setDay = (d: number, on: boolean) => {
    const next = { ...hours };
    if (on) next[String(d)] = hours[String(d)]?.length ? hours[String(d)] : [['08:00', '17:00']];
    else delete next[String(d)];
    setHours(next);
  };
  const setTime = (d: number, i: 0 | 1, v: string) => {
    const cur = hours[String(d)]?.[0] ?? ['08:00', '17:00'];
    const w: [string, string] = i === 0 ? [v, cur[1]] : [cur[0], v];
    setHours({ ...hours, [String(d)]: [w] });
  };

  const timed = Boolean(n.business_hours && n.after_hours_dest);

  return (
    <div className="section">
      <div className="section-head">
        <div>
          <h2 className="ltr" style={{ display: 'inline-block' }}>{n.e164}</h2>
          {n.label && <div className="muted small">{n.label}</div>}
        </div>
        {!edit && <button className="btn" onClick={() => setEdit(true)}>تعديل المسار</button>}
      </div>

      {!edit && (
        <div className="route" aria-label="مسار المكالمة">
          <div className="route-step">
            <span className="route-node">1</span>
            <div className="route-body">
              <div>تصل المكالمة على الرقم</div>
              {timed && <div className="muted small">أوقات الدوام: {hoursSummary(n.business_hours!)}</div>}
            </div>
          </div>
          <div className="route-step">
            <span className="route-node">2</span>
            <div className="route-body">
              <div>{timed ? 'وقت الدوام تروح إلى' : 'تروح إلى'} <strong>{destinationLabel(n.destination, dir)}</strong></div>
            </div>
          </div>
          {timed && (
            <div className="route-step">
              <span className="route-node alt">2</span>
              <div className="route-body">
                <div>بعد الدوام تروح إلى <strong>{destinationLabel(n.after_hours_dest, dir)}</strong></div>
              </div>
            </div>
          )}
        </div>
      )}

      {edit && (
        <div className="stack">
          <label className="field">اسم الرقم (اختياري)<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مثلاً: الرقم الرئيسي" /></label>
          <label className="field">
            {useHours ? 'وقت الدوام تروح المكالمة إلى' : 'المكالمات الواردة تروح إلى'}
            <DestinationPicker value={dest} onChange={setDest} />
          </label>
          <label className="check">
            <input type="checkbox" checked={useHours} onChange={(e) => setUseHours(e.target.checked)} />
            <span>وجّه المكالمات بشكل مختلف خارج أوقات الدوام</span>
          </label>
          {useHours && (
            <>
              <div className="hours">
                {dayNames.map((name, d) => {
                  const on = Boolean(hours[String(d)]?.length);
                  const w = hours[String(d)]?.[0] ?? ['08:00', '17:00'];
                  return (
                    <div key={d} style={{ display: 'contents' }}>
                      <label className="check"><input type="checkbox" checked={on} onChange={(e) => setDay(d, e.target.checked)} />{name}</label>
                      <div className="times">
                        {on ? (
                          <>
                            <input type="time" value={w[0]} onChange={(e) => setTime(d, 0, e.target.value)} aria-label={`بداية ${name}`} />
                            <span className="muted">إلى</span>
                            <input type="time" value={w[1]} onChange={(e) => setTime(d, 1, e.target.value)} aria-label={`نهاية ${name}`} />
                          </>
                        ) : (
                          <span className="muted small">مغلق</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <label className="field">
                بعد الدوام تروح المكالمة إلى
                <DestinationPicker value={after} onChange={setAfter} />
              </label>
            </>
          )}
          <ErrorNote error={error} />
          <div className="row">
            <button className="btn primary" onClick={save} disabled={busy}>حفظ المسار</button>
            <button className="btn quiet" onClick={() => setEdit(false)}>إلغاء</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Numbers() {
  const { data, error, reload } = useLoad(() => api.get<PhoneNumber[]>('/api/numbers'));
  return (
    <>
      <PageHead title="الأرقام ومسار المكالمة" intro="حدد وين تروح المكالمة لما أحد يتصل على رقم شركتك، وش يصير بعد الدوام." />
      <ErrorNote error={error} />
      {data?.length === 0 && (
        <div className="section empty">ما فيه أرقام مربوطة بحسابك. مزود الخدمة يربط الرقم، وبعدها يظهر هنا.</div>
      )}
      {data?.map((n) => <NumberCard key={n.id} n={n} onSaved={reload} />)}
    </>
  );
}
