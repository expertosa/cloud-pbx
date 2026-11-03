import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type Call, type Me } from '../api';
import { CallsTable } from './Calls';
import { ErrorNote, PageHead, useLoad } from '../components/ui';

export default function Overview({ me }: { me: Me }) {
  const stats = useLoad(() => api.get('/api/stats'));
  const calls = useLoad(() => api.get<Call[]>('/api/calls'));
  const s = stats.data;
  // Keep the numbers fresh while the page is open.
  useEffect(() => {
    const t = window.setInterval(() => {
      void stats.reload();
      void calls.reload();
    }, 15000);
    return () => window.clearInterval(t);
  }, [stats.reload, calls.reload]);
  const isAdmin = me.user.role !== 'agent';
  const greeting = new Date().getHours() < 12 ? 'صباح الخير' : 'مساء الخير';

  return (
    <>
      <PageHead title={`${greeting}، ${me.user.name.split(' ')[0]}`} intro="هذا ملخص مكالمات اليوم." />
      <ErrorNote error={stats.error} />
      {s && (
        <div className="strip">
          <div><div className="v">{s.today}</div><div className="k">مكالمة اليوم</div></div>
          <div><div className="v">{s.answered_today}</div><div className="k">تم الرد عليها</div></div>
          <div><div className={`v ${s.missed_today ? 'miss' : ''}`}>{s.missed_today}</div><div className="k">فائتة أو بريد صوتي</div></div>
          <div><div className="v">{s.talk_minutes_today}</div><div className="k">دقيقة تحدث</div></div>
          <div><div className={`v ${s.active_calls ? 'live' : ''}`}>{s.active_calls}</div><div className="k">مكالمة جارية الآن</div></div>
        </div>
      )}

      {isAdmin && s && s.numbers === 0 && (
        <div className="alert warn" style={{ marginBottom: 18 }}>
          ما عندك رقم هاتف مربوط بعد. تواصل مع مزود الخدمة لربط رقمك، وبعدها حدد مسار المكالمات من صفحة الأرقام.
        </div>
      )}

      {s && s.unread_voicemails > 0 && (
        <div className="alert warn" style={{ marginBottom: 18 }}>
          عندك {s.unread_voicemails} {s.unread_voicemails === 1 ? 'رسالة صوتية جديدة' : 'رسائل صوتية جديدة'}. <Link to="/voicemail">اسمعها</Link>
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <h2>آخر المكالمات</h2>
          <Link to="/calls" className="small">السجل كامل</Link>
        </div>
        <ErrorNote error={calls.error} />
        {calls.data && <CallsTable calls={calls.data.slice(0, 8)} />}
      </div>
    </>
  );
}
