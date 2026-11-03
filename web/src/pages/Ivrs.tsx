import { useRef, useState } from 'react';
import { api, type AudioFile, type Destination, type Ivr } from '../api';
import { DestinationPicker, destinationLabel, useDirectory } from '../components/directory';
import { ErrorNote, Modal, PageHead, useAction, useLoad } from '../components/ui';
import { duration } from '../format';

const KEY_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*'];

function IvrEditor({ ivr, audio, onClose, onSaved }: { ivr: Ivr | null; audio: AudioFile[]; onClose: () => void; onSaved: () => void }) {
  const dir = useDirectory();
  const fallback: Destination = dir.groups[0] ? { type: 'ring_group', id: dir.groups[0].id } : dir.extensions[0] ? { type: 'extension', id: dir.extensions[0].id } : { type: 'hangup' };
  const [f, setF] = useState<Omit<Ivr, 'id'>>(
    ivr ?? { name: '', greeting_id: audio[0]?.id ?? null, options: { '1': fallback }, allow_direct_dial: true, timeout_s: 6, timeout_dest: fallback },
  );
  const { busy, error, run } = useAction();
  const keys = KEY_ORDER.filter((k) => f.options[k]);
  const freeKey = KEY_ORDER.find((k) => !f.options[k]);

  const setOpt = (k: string, d: Destination | null) => {
    const options = { ...f.options };
    if (d) options[k] = d;
    else delete options[k];
    setF({ ...f, options });
  };
  const changeKey = (from: string, to: string) => {
    const options = { ...f.options };
    const d = options[from];
    delete options[from];
    options[to] = d;
    setF({ ...f, options });
  };

  const save = async () => {
    const ok = await run(() => (ivr ? api.put(`/api/ivrs/${ivr.id}`, f) : api.post('/api/ivrs', f)));
    if (ok) {
      await dir.reload();
      onSaved();
      onClose();
    }
  };

  return (
    <Modal title={ivr ? `تعديل ${ivr.name}` : 'رد آلي جديد'} onClose={onClose}>
      <div className="stack">
        <label className="field">الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="مثلاً: الترحيب الرئيسي" /></label>
        <label className="field">
          رسالة الترحيب
          <select value={f.greeting_id ?? ''} onChange={(e) => setF({ ...f, greeting_id: e.target.value || null })}>
            <option value="">الترحيب الافتراضي (اضغط رقم التحويلة أو انتظر)</option>
            {audio.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <span className="hint">ارفع تسجيلك من قسم «الرسائل الصوتية» في نفس الصفحة. مثال: «أهلاً بكم في عيادة النخبة، للحجز اضغط 1، للاستفسارات اضغط 2».</span>
        </label>

        <div>
          <div className="small" style={{ fontWeight: 500, marginBottom: 8 }}>لما يضغط المتصل</div>
          <div className="keys">
            {keys.map((k) => (
              <div key={k} style={{ display: 'contents' }}>
                <select className="key-cap" style={{ padding: 0, textAlign: 'center', width: 52 }} value={k} onChange={(e) => changeKey(k, e.target.value)} aria-label="الزر">
                  {KEY_ORDER.filter((x) => x === k || !f.options[x]).map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <DestinationPicker value={f.options[k]} onChange={(d) => setOpt(k, d)} exclude={ivr?.id} />
                <button className="btn quiet danger" onClick={() => setOpt(k, null)} aria-label={`حذف الزر ${k}`}>×</button>
              </div>
            ))}
          </div>
          {freeKey && <button className="btn quiet small" style={{ marginTop: 8 }} onClick={() => setOpt(freeKey, fallback)}>إضافة زر</button>}
        </div>

        <label className="check">
          <input type="checkbox" checked={f.allow_direct_dial} onChange={(e) => setF({ ...f, allow_direct_dial: e.target.checked })} />
          <span>يقدر المتصل يكتب رقم التحويلة مباشرة (مثل 102)</span>
        </label>
        <div className="grid-2">
          <label className="field">ينتظر المتصل (ثواني)<input type="number" min={2} max={30} value={f.timeout_s} onChange={(e) => setF({ ...f, timeout_s: Number(e.target.value) })} /></label>
          <label className="field">إذا ما ضغط شي، تروح المكالمة إلى<DestinationPicker value={f.timeout_dest} onChange={(d) => setF({ ...f, timeout_dest: d })} exclude={ivr?.id} /></label>
        </div>
        <span className="muted small">تتكرر رسالة الترحيب 3 مرات قبل التحويل.</span>
        <ErrorNote error={error} />
        <div className="modal-foot">
          <button className="btn primary" onClick={save} disabled={busy || !f.name}>حفظ</button>
          <button className="btn quiet" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

function AudioLibrary({ audio, reload }: { audio: AudioFile[]; reload: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('name', name || f.name.replace(/\.[^.]+$/, ''));
    fd.append('file', f);
    const ok = await run(() => api.post('/api/audio', fd));
    if (ok) {
      setName('');
      if (file.current) file.current.value = '';
      reload();
    }
  };
  const remove = async (a: AudioFile) => {
    if (!confirm(`تحذف «${a.name}»؟`)) return;
    await api.del(`/api/audio/${a.id}`);
    reload();
  };
  return (
    <div className="section">
      <div className="section-head"><h2>الرسائل الصوتية</h2></div>
      <p className="muted small" style={{ marginBottom: 14 }}>سجّل رسالة الترحيب بجوالك (WAV أو MP3 أو M4A) وارفعها هنا، ونحولها تلقائياً لجودة الهاتف.</p>
      <div className="row" style={{ marginBottom: 14 }}>
        <input style={{ maxWidth: 220 }} placeholder="اسم الرسالة" value={name} onChange={(e) => setName(e.target.value)} aria-label="اسم الرسالة" />
        <input ref={file} type="file" accept="audio/*" style={{ maxWidth: 260 }} aria-label="الملف" />
        <button className="btn" onClick={upload} disabled={busy}>{busy ? 'جاري الرفع...' : 'رفع'}</button>
      </div>
      <ErrorNote error={error} />
      {audio.length === 0 ? (
        <div className="empty">ما رفعت رسائل بعد.</div>
      ) : (
        <table>
          <tbody>
            {audio.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td className="num">{duration(a.duration_s ? Number(a.duration_s) : null)}</td>
                <td><audio src={`/api/audio/${a.id}/file`} controls preload="none" /></td>
                <td><button className="btn quiet danger small" onClick={() => remove(a)}>حذف</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Ivrs() {
  const dir = useDirectory();
  const audio = useLoad(() => api.get<AudioFile[]>('/api/audio'));
  const [editing, setEditing] = useState<Ivr | null | 'new'>(null);
  const { error, run } = useAction();
  const remove = async (i: Ivr) => {
    if (!confirm(`تحذف «${i.name}»؟`)) return;
    const ok = await run(() => api.del(`/api/ivrs/${i.id}`));
    if (ok) void dir.reload();
  };
  return (
    <>
      <PageHead title="الرد الآلي" intro="رسالة ترحيب تخلي المتصل يختار القسم بالضغط على رقم.">
        <button className="btn primary" onClick={() => setEditing('new')}>رد آلي جديد</button>
      </PageHead>
      <ErrorNote error={error} />
      <div className="section">
        {dir.ivrs.length === 0 ? (
          <div className="empty">
            ما فيه رد آلي. أنشئ واحد وبعدها اختاره من صفحة الأرقام.
            <div><button className="btn" onClick={() => setEditing('new')}>رد آلي جديد</button></div>
          </div>
        ) : (
          <table>
            <thead><tr><th>الاسم</th><th>الأزرار</th><th className="hide-sm">إذا ما ضغط</th><th aria-label="إجراءات" /></tr></thead>
            <tbody>
              {dir.ivrs.map((i) => (
                <tr key={i.id}>
                  <td style={{ fontWeight: 500 }}>{i.name}</td>
                  <td className="small">
                    {KEY_ORDER.filter((k) => i.options[k]).map((k) => (
                      <div key={k}><span className="num" style={{ fontWeight: 600 }}>{k}</span> ← {destinationLabel(i.options[k], dir)}</div>
                    ))}
                  </td>
                  <td className="hide-sm small">{destinationLabel(i.timeout_dest, dir)}</td>
                  <td>
                    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <button className="btn quiet small" onClick={() => setEditing(i)}>تعديل</button>
                      <button className="btn quiet danger small" onClick={() => remove(i)}>حذف</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AudioLibrary audio={audio.data ?? []} reload={audio.reload} />
      {editing && (
        <IvrEditor ivr={editing === 'new' ? null : editing} audio={audio.data ?? []} onClose={() => setEditing(null)} onSaved={() => {}} />
      )}
    </>
  );
}
