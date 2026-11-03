import { api } from '../api';
import { duration, phone, when } from '../format';
import { ErrorNote, PageHead, useLoad } from '../components/ui';

interface Vm { id: string; caller: string | null; duration_s: number; listened: boolean; created_at: string; ext_number: string | null; ext_name: string | null }

export default function Voicemails({ canDelete }: { canDelete: boolean }) {
  const { data, error, reload, setData } = useLoad(() => api.get<Vm[]>('/api/voicemails'));
  const mark = async (v: Vm) => {
    if (v.listened) return;
    setData(data?.map((x) => (x.id === v.id ? { ...x, listened: true } : x)));
    await api.patch(`/api/voicemails/${v.id}`, { listened: true }).catch(() => {});
  };
  const remove = async (v: Vm) => {
    if (!confirm('تحذف هذه الرسالة نهائياً؟')) return;
    await api.del(`/api/voicemails/${v.id}`);
    void reload();
  };
  return (
    <>
      <PageHead title="البريد الصوتي" intro="الرسائل اللي تركها المتصلون لما ما أحد رد. الرسائل الجديدة بخط عريض." />
      <div className="section">
        <ErrorNote error={error} />
        {data?.length === 0 && <div className="empty">ما فيه رسائل صوتية.</div>}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>من</th><th>لمن</th><th className="hide-sm">الوقت</th><th>المدة</th><th>استماع</th>{canDelete && <th aria-label="حذف" />}</tr></thead>
              <tbody>
                {data.map((v) => (
                  <tr key={v.id} className={v.listened ? '' : 'unread'}>
                    <td className="ltr">{phone(v.caller)}</td>
                    <td>{v.ext_name ?? '—'}</td>
                    <td className="hide-sm muted">{when(v.created_at)}</td>
                    <td className="num">{duration(v.duration_s)}</td>
                    <td><audio src={`/api/voicemails/${v.id}/audio`} controls preload="none" onPlay={() => mark(v)} /></td>
                    {canDelete && <td><button className="btn quiet danger small" onClick={() => remove(v)}>حذف</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
