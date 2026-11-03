import { useState } from 'react';
import { api, type Destination, type RingGroup } from '../api';
import { DestinationPicker, destinationLabel, useDirectory } from '../components/directory';
import { ErrorNote, Modal, PageHead, useAction } from '../components/ui';

function GroupEditor({ g, onClose }: { g: RingGroup | null; onClose: () => void }) {
  const dir = useDirectory();
  const [f, setF] = useState<Omit<RingGroup, 'id'>>(
    g ?? { name: '', number: '', strategy: 'simultaneous', ring_seconds: 25, member_ids: dir.extensions.map((e) => e.id), fallback: dir.extensions[0] ? { type: 'voicemail', id: dir.extensions[0].id } : { type: 'hangup' } },
  );
  const { busy, error, run } = useAction();
  const toggle = (id: string) => setF({ ...f, member_ids: f.member_ids.includes(id) ? f.member_ids.filter((x) => x !== id) : [...f.member_ids, id] });
  const save = async () => {
    const body = { ...f, number: f.number || null };
    const ok = await run(() => (g ? api.put(`/api/ring-groups/${g.id}`, body) : api.post('/api/ring-groups', body)));
    if (ok) {
      await dir.reload();
      onClose();
    }
  };
  return (
    <Modal title={g ? `تعديل ${g.name}` : 'مجموعة رنين جديدة'} onClose={onClose}>
      <div className="stack">
        <div className="grid-2">
          <label className="field">الاسم<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="مثلاً: الاستقبال" /></label>
          <label className="field">رقم المجموعة (اختياري)<input className="num" value={f.number ?? ''} onChange={(e) => setF({ ...f, number: e.target.value.replace(/\D/g, '') })} placeholder="200" /><span className="hint">يقدر الموظفون يتصلون عليه داخلياً</span></label>
        </div>
        <div>
          <div className="small" style={{ fontWeight: 500, marginBottom: 8 }}>الموظفون في المجموعة</div>
          <div className="grid-2">
            {dir.extensions.map((e) => (
              <label key={e.id} className="check"><input type="checkbox" checked={f.member_ids.includes(e.id)} onChange={() => toggle(e.id)} />{e.name} <span className="muted num">{e.number}</span></label>
            ))}
          </div>
        </div>
        <div className="grid-2">
          <label className="field">
            طريقة الرنين
            <select value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value as RingGroup['strategy'] })}>
              <option value="simultaneous">يرن عند الجميع مع بعض</option>
              <option value="sequential">يرن بالترتيب واحد بعد الثاني</option>
            </select>
          </label>
          <label className="field">مدة الرنين (ثواني){f.strategy === 'sequential' && <span className="hint">لكل موظف</span>}<input type="number" min={5} max={120} value={f.ring_seconds} onChange={(e) => setF({ ...f, ring_seconds: Number(e.target.value) })} /></label>
        </div>
        <label className="field">إذا ما أحد رد، تروح المكالمة إلى<DestinationPicker value={f.fallback} onChange={(d: Destination) => setF({ ...f, fallback: d })} exclude={g?.id} /></label>
        <ErrorNote error={error} />
        <div className="modal-foot">
          <button className="btn primary" onClick={save} disabled={busy || !f.name}>حفظ</button>
          <button className="btn quiet" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Groups() {
  const dir = useDirectory();
  const [editing, setEditing] = useState<RingGroup | null | 'new'>(null);
  const { error, run } = useAction();
  const remove = async (g: RingGroup) => {
    if (!confirm(`تحذف مجموعة «${g.name}»؟`)) return;
    if (await run(() => api.del(`/api/ring-groups/${g.id}`))) void dir.reload();
  };
  const names = (ids: string[]) => ids.map((id) => dir.extensions.find((e) => e.id === id)?.name).filter(Boolean).join('، ');
  return (
    <>
      <PageHead title="مجموعات الرنين" intro="مجموعة موظفين يرن عندهم نفس الاتصال، وأول واحد يرد يستلم المكالمة.">
        <button className="btn primary" onClick={() => setEditing('new')}>مجموعة جديدة</button>
      </PageHead>
      <ErrorNote error={error} />
      <div className="section">
        {dir.groups.length === 0 ? (
          <div className="empty">ما فيه مجموعات. أنشئ مجموعة «الاستقبال» مثلاً.<div><button className="btn" onClick={() => setEditing('new')}>مجموعة جديدة</button></div></div>
        ) : (
          <table>
            <thead><tr><th>المجموعة</th><th>الموظفون</th><th className="hide-sm">إذا ما أحد رد</th><th aria-label="إجراءات" /></tr></thead>
            <tbody>
              {dir.groups.map((g) => (
                <tr key={g.id}>
                  <td><div style={{ fontWeight: 500 }}>{g.name}</div><div className="dir">{g.number ? <span className="num">{g.number}</span> : 'بدون رقم'}، {g.strategy === 'simultaneous' ? 'رنين جماعي' : 'رنين بالترتيب'}، {g.ring_seconds} ث</div></td>
                  <td className="small">{names(g.member_ids) || <span className="muted">بدون أعضاء</span>}</td>
                  <td className="hide-sm small">{destinationLabel(g.fallback, dir)}</td>
                  <td><div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}><button className="btn quiet small" onClick={() => setEditing(g)}>تعديل</button><button className="btn quiet danger small" onClick={() => remove(g)}>حذف</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <GroupEditor g={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
