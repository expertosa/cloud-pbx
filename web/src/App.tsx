import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, type Me } from './api';
import { DirectoryProvider } from './components/directory';
import Phone from './components/Phone';
import { Icon } from './components/ui';
import Admin from './pages/Admin';
import Calls from './pages/Calls';
import Groups from './pages/Groups';
import Ivrs from './pages/Ivrs';
import Login from './pages/Login';
import Numbers from './pages/Numbers';
import Overview from './pages/Overview';
import Settings from './pages/Settings';
import Team from './pages/Team';
import Voicemails from './pages/Voicemails';

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = useCallback(() => api.get<Me>('/api/auth/me').then(setMe).catch(() => setMe(null)), []);
  useEffect(() => {
    void load();
    const out = () => setMe(null);
    window.addEventListener('pbx:logout', out);
    return () => window.removeEventListener('pbx:logout', out);
  }, [load]);

  if (me === undefined) return null;
  if (me === null) return <Login onDone={load} />;
  if (me.user.role === 'superadmin') return <AdminShell me={me} />;
  return (
    <DirectoryProvider>
      <Shell me={me} />
    </DirectoryProvider>
  );
}

function Brand({ sub }: { sub: string }) {
  return (
    <div className="brand">
      <span className="brand-mark" style={{ color: '#3fd3a7' }}>{Icon.phone(18)}</span>
      <div>
        <div className="brand-name">السنترال السحابي</div>
        <div className="brand-co">{sub}</div>
      </div>
    </div>
  );
}

async function logout() {
  await api.post('/api/auth/logout').catch(() => {});
  window.location.href = '/';
}

function Shell({ me }: { me: Me }) {
  const isAdmin = me.user.role === 'owner' || me.user.role === 'admin';
  const [menu, setMenu] = useState(false);
  const [unread, setUnread] = useState(0);
  const loc = useLocation();
  useEffect(() => setMenu(false), [loc.pathname]);
  useEffect(() => {
    const tick = () => api.get('/api/stats').then((s) => setUnread(s.unread_voicemails)).catch(() => {});
    tick();
    const t = window.setInterval(tick, 30000);
    return () => window.clearInterval(t);
  }, [loc.pathname]);

  return (
    <>
      <div className="mobile-bar">
        <strong>{me.tenant?.name}</strong>
        <button className="btn quiet" onClick={() => setMenu(true)} aria-label="القائمة">{Icon.menu()}</button>
      </div>
      <div className="shell">
        <nav className={`side ${menu ? 'open' : ''}`} aria-label="القائمة الرئيسية">
          <Brand sub={me.tenant?.name ?? ''} />
          <div className="nav">
            <NavLink to="/" end>الرئيسية</NavLink>
            <NavLink to="/calls">سجل المكالمات</NavLink>
            <NavLink to="/voicemail">البريد الصوتي {unread > 0 && <span className="badge num">{unread}</span>}</NavLink>
            {isAdmin && (
              <>
                <div className="nav-sep" />
                <NavLink to="/numbers">الأرقام ومسار المكالمة</NavLink>
                <NavLink to="/ivr">الرد الآلي</NavLink>
                <NavLink to="/groups">مجموعات الرنين</NavLink>
                <NavLink to="/team">الموظفون والتحويلات</NavLink>
                <NavLink to="/settings">الإعدادات</NavLink>
              </>
            )}
          </div>
          <div className="side-foot">
            <div>{me.user.name}</div>
            <div className="muted small">{me.extension ? `تحويلة ${me.extension.number}` : me.user.email}</div>
            <button className="btn quiet small" style={{ marginTop: 6, paddingInline: 0 }} onClick={logout}>تسجيل الخروج</button>
          </div>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Overview me={me} />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/voicemail" element={<Voicemails canDelete={isAdmin} />} />
            {isAdmin && <Route path="/numbers" element={<Numbers />} />}
            {isAdmin && <Route path="/ivr" element={<Ivrs />} />}
            {isAdmin && <Route path="/groups" element={<Groups />} />}
            {isAdmin && <Route path="/team" element={<Team me={me} />} />}
            {isAdmin && <Route path="/settings" element={<Settings />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <Phone />
    </>
  );
}

function AdminShell({ me }: { me: Me }) {
  return (
    <div className="shell">
      <nav className="side" aria-label="القائمة الرئيسية">
        <Brand sub="إدارة المنصة" />
        <div className="nav">
          <NavLink to="/" end>الشركات والأرقام</NavLink>
        </div>
        <div className="side-foot">
          <div>{me.user.email}</div>
          <button className="btn quiet small" style={{ marginTop: 6, paddingInline: 0 }} onClick={logout}>تسجيل الخروج</button>
        </div>
      </nav>
      <main className="main">
        <Admin />
      </main>
    </div>
  );
}
