import { useState } from 'react';
import { api, type Extension, type Me } from '../api';
import { useDirectory } from '../components/directory';
import { Copy, ErrorNote, Modal, PageHead, useAction, useLoad } from '../components/ui';

interface User { id: string; name: string; email: string; role: 'owner' | 'admin' | 'agent' }
const roleLabel = { owner: 'مالك الحساب', admin: 'مدير', agent: 'موظف' };

function SipDetails({ ext, onClose }: { ext: Extension; onClose: () => void }) {
  const dir = useDirectory();
  const [e, setE] = useState(ext);
  const { busy, error, run } = useAction();
  const reset = async () => {
    if (!confirm('بنغيّر كلمة المرور، وأي جهاز مربوط حالياً بيحتاج الكلمة الجديدة. نكمل؟')) return;
    const r = await run(() => api.post<Extension>(`/api/extensions/${e.id}/reset-password`));
    if (r) {
      setE(r);
      void dir.reload();
    }
  };
  return (
    <Modal title={`ربط جوال أو هاتف مكتبي للتحويلة ${e.number}`} onClose={onClose}>
      <p className="small muted" style={{ marginBottom: 14 }}>
        نزّل تطبيق Zoiper أو Linphone على الجوال، أضف حساب SIP، وانسخ البيانات هذي. أي جهاز تربطه بيرن مع هاتف المتصفح.
      </p>
      <dl className="kv">
        <dt>الخادم (Domain)</dt><dd><span className="secret">{e.sip_domain}</span> <Copy value={e.sip_domain ?? ''} /></dd>
        <dt>المنفذ</dt><dd><span className="secret">{e.sip_port}</span></dd>
        <dt>اسم المستخدم</dt><dd><span className="secret">{e.sip_username}</span> <Copy value={e.sip_username} /></dd>
        <dt>كلمة المرور</dt><dd><span className="secret">{e.sip_password}</span> <Copy value={e.sip_password ?? ''} /></dd>
        <dt>النقل</dt><dd>UDP أو TCP</dd>
      </dl>
      <ErrorNote error={error} />
      <div className="modal-foot">
        <button className="btn primary" onClick={onClose}>تم</button>
        <button className="btn quiet danger" onClick={reset} disabled={busy}>تغيير كلمة المرور</button>
      </div>
    </Modal>
  );
}

function AddPerson({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const dir = useDirectory();
  const [kind, setKind] = useState<'user' | 'line'>('user');
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'agent', number: '' });
  const { busy, error, run } = useAction();
  const save = async () => {
    const ok =
      kind === 'user'
        ? await run(() => api.post('/api/users', { name: f.name, email: f.email, password: f.password, role: f.role, extensionNumber: f.number || undefined }))
        : await run(() => api.post('/api/extensions', { name: f.name, number: f.number || undefined }));
    if (ok) {
      await dir.reload();
      onDone();
      onClose();
    }
  };
  return (
    <Modal title="إضافة" onClose={onClose}>
      <div className="stack">
        <div className="row">
          <label className="check"><input type="radio" checked={kind === 'user'} onChange={() => setKind('user')} />موظف يدخل اللوحة ويرد من المتصفح</label>
          <label className="check"><input type="radio" checked={kind === 'line'} onChange={() => setKind('line')} />تحويلة فقط (هاتف مكتبي أو قسم)</label>
        </div>
        <div className="grid-2">
          <label className="field">{kind === 'user' ? 'الاسم' : 'اسم التحويلة'}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">رقم التحويلة<input className="num" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value.replace(/\D/g, '') })} placeholder="تلقائي" /></label>
        </div>
        {kind === 'user' && (
          <>
            <div className="grid-2">
              <label className="field">البريد الإلكتروني<input type="email" dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
              <label className="field">كلمة مرور مؤقتة<input dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /><span className="hint">8 أحرف على الأقل</span></label>
            </div>
            <label className="field">الصلاحية
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="agent">موظف: يرد ويتصل ويشوف مكالماته</option>
                <option value="admin">مدير: يقدر يعدل الإعدادات والمسارات</option>
              </select>
            </label>
          </>
        )}
        <ErrorNote error={error} />
        <div className="modal-foot">
          <button className="btn primary" onClick={save} disabled={busy || !f.name}>إضافة</button>
          <button className="btn quiet" onClick={onClose}>إلغاء</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Team({ me }: { me: Me }) {
  const dir = useDirectory();
  const users = useLoad(() => api.get<User[]>('/api/users'));
  const [sip, setSip] = useState<Extension | null>(null);
  const [adding, setAdding] = useState(false);
  const { error, run } = useAction();
  const userOf = (e: Extension) => users.data?.find((u) => u.id === e.user_id);

  const toggle = async (e: Extension, key: 'voicemail_enabled' | 'outbound_allowed') => {
    if (await run(() => api.patch(`/api/extensions/${e.id}`, { [key]: !e[key] }))) void dir.reload();
  };
  const remove = async (e: Extension) => {
    const u = userOf(e);
    if (!confirm(u && u.role !== 'owner' ? `تحذف ${e.name} وتحويلته ${e.number}؟` : `تحذف التحويلة ${e.number}؟`)) return;
    const ok = await run(async () => {
      await api.del(`/api/extensions/${e.id}`);
      if (u && u.role !== 'owner' && u.id !== me.user.id) await api.del(`/api/users/${u.id}`);
    });
    if (ok) {
      void dir.reload();
      void users.reload();
    }
  };

  return (
    <>
      <PageHead title="الموظفون والتحويلات" intro="كل موظف له تحويلة يرد عليها من المتصفح، ويقدر يربط جواله أو هاتف مكتبي بنفس التحويلة.">
        <button className="btn primary" onClick={() => setAdding(true)}>إضافة موظف</button>
      </PageHead>
      <ErrorNote error={error} />
      <div className="section">
        <div className="table-wrap">
          <table>
            <thead><tr><th>التحويلة</th><th>الموظف</th><th className="hide-sm">بريد صوتي</th><th className="hide-sm">اتصال خارجي</th><th aria-label="إجراءات" /></tr></thead>
            <tbody>
              {dir.extensions.map((e) => {
                const u = userOf(e);
                return (
                  <tr key={e.id}>
                    <td><span className="row" style={{ gap: 8 }}><span className={`dot-online ${e.online ? 'on' : ''}`} title={e.online ? 'متصل' : 'غير متصل'} /><strong className="num">{e.number}</strong></span></td>
                    <td><div style={{ fontWeight: 500 }}>{e.name}</div><div className="dir">{u ? `${roleLabel[u.role]}، ${u.email}` : 'تحويلة بدون حساب'}</div></td>
                    <td className="hide-sm"><input type="checkbox" checked={e.voicemail_enabled} onChange={() => toggle(e, 'voicemail_enabled')} aria-label="البريد الصوتي" /></td>
                    <td className="hide-sm"><input type="checkbox" checked={e.outbound_allowed} onChange={() => toggle(e, 'outbound_allowed')} aria-label="الاتصال الخارجي" /></td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        <button className="btn quiet small" onClick={() => setSip(e)}>ربط جوال</button>
                        {u?.role !== 'owner' && <button className="btn quiet danger small" onClick={() => remove(e)}>حذف</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {sip && <SipDetails ext={sip} onClose={() => setSip(null)} />}
      {adding && <AddPerson onClose={() => setAdding(false)} onDone={users.reload} />}
    </>
  );
}
