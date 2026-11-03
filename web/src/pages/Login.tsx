import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorNote, useAction } from '../components/ui';

export default function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [allowSignup, setAllowSignup] = useState(false);
  const [f, setF] = useState({ company: '', name: '', email: '', password: '' });
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    api.get('/api/auth/options').then((o) => setAllowSignup(o.allowSignup)).catch(() => {});
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => (mode === 'login' ? api.post('/api/auth/login', { email: f.email, password: f.password }) : api.post('/api/auth/signup', f)));
    if (ok) onDone();
  };

  return (
    <div className="auth">
      <div className="auth-art">
        <div className="brand-name" style={{ fontSize: 17 }}>السنترال السحابي</div>
        <p className="lines">كل مكالمات شركتك في مكان واحد، وترد عليها من المتصفح أو الجوال.</p>
        <div className="digits" aria-hidden="true">1 2 3   4 5 6   7 8 9   * 0 #</div>
      </div>
      <div className="auth-form">
        <form onSubmit={submit} className="stack">
          <h1>{mode === 'login' ? 'تسجيل الدخول' : 'افتح حساب لشركتك'}</h1>
          {mode === 'signup' && (
            <>
              <label className="field">اسم الشركة<input value={f.company} onChange={set('company')} required minLength={2} autoComplete="organization" /></label>
              <label className="field">اسمك<input value={f.name} onChange={set('name')} required minLength={2} autoComplete="name" /></label>
            </>
          )}
          <label className="field">البريد الإلكتروني<input type="email" value={f.email} onChange={set('email')} required autoComplete="email" dir="ltr" /></label>
          <label className="field">
            كلمة المرور
            <input type="password" value={f.password} onChange={set('password')} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} dir="ltr" />
            {mode === 'signup' && <span className="hint">8 أحرف على الأقل</span>}
          </label>
          <ErrorNote error={error} />
          <button className="btn primary" disabled={busy}>{busy ? 'لحظة...' : mode === 'login' ? 'دخول' : 'إنشاء الحساب'}</button>
          {allowSignup && (
            <button type="button" className="btn quiet" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(undefined); }}>
              {mode === 'login' ? 'ما عندك حساب؟ سجّل شركتك' : 'عندك حساب؟ سجّل دخول'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
