import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JsSIP from 'jssip';
import { api } from '../api';
import { phone as fmtPhone } from '../format';
import { Icon } from './ui';

interface PhoneConfig {
  extension: { id: string; number: string; name: string } | null;
  wsUrl?: string;
  domain?: string;
  username?: string;
  password?: string;
}

type Reg = 'off' | 'connecting' | 'on' | 'error';
type CallState = 'idle' | 'calling' | 'incoming' | 'active';

const KEYS: [string, string][] = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/** Simple two-tone ring generated in the browser, no audio file needed. */
function useRinger() {
  const ctx = useRef<AudioContext | null>(null);
  const timer = useRef<number | null>(null);
  const stop = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
  }, []);
  const start = useCallback(() => {
    stop();
    try {
      ctx.current ??= new AudioContext();
      const c = ctx.current;
      const beep = () => {
        for (const [f, at] of [[440, 0], [480, 0]] as const) {
          const o = c.createOscillator();
          const g = c.createGain();
          o.frequency.value = f;
          g.gain.value = 0.06;
          o.connect(g).connect(c.destination);
          o.start(c.currentTime + at);
          o.stop(c.currentTime + at + 1.2);
        }
      };
      beep();
      timer.current = window.setInterval(beep, 3000);
    } catch {
      /* audio blocked until the user interacts with the page */
    }
  }, [stop]);
  return useMemo(() => ({ start, stop }), [start, stop]);
}

export default function Phone() {
  const [cfg, setCfg] = useState<PhoneConfig | null>(null);
  const [reg, setReg] = useState<Reg>('off');
  const [open, setOpen] = useState(false);
  const [dial, setDial] = useState('');
  const [state, setState] = useState<CallState>('idle');
  const [peer, setPeer] = useState<{ number: string; name?: string }>({ number: '' });
  const [muted, setMuted] = useState(false);
  const [showPad, setShowPad] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState('');
  const ua = useRef<JsSIP.UA | null>(null);
  const session = useRef<any>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const startedAt = useRef<number>(0);
  const ringer = useRinger();

  useEffect(() => {
    api.get<PhoneConfig>('/api/phone').then(setCfg).catch(() => setCfg({ extension: null }));
  }, []);

  const reset = useCallback(() => {
    session.current = null;
    ringer.stop();
    setState('idle');
    setMuted(false);
    setShowPad(false);
    setElapsed(0);
  }, [ringer]);

  const attachMedia = useCallback((s: any) => {
    const pc: RTCPeerConnection | undefined = s.connection;
    const bind = () => {
      const stream = new MediaStream();
      pc?.getReceivers().forEach((r) => r.track && stream.addTrack(r.track));
      if (audio.current) {
        audio.current.srcObject = stream;
        void audio.current.play().catch(() => {});
      }
    };
    if (pc) {
      pc.addEventListener('track', bind);
      bind();
    } else {
      s.on('peerconnection', (e: any) => e.peerconnection.addEventListener('track', bind));
    }
  }, []);

  const wireSession = useCallback(
    (s: any) => {
      session.current = s;
      s.on('progress', () => setNote('يرن...'));
      s.on('accepted', () => {
        ringer.stop();
        startedAt.current = Date.now();
        setState('active');
        setNote('');
      });
      s.on('confirmed', () => attachMedia(s));
      s.on('ended', () => {
        setNote('انتهت المكالمة');
        reset();
      });
      s.on('failed', (e: any) => {
        const cause = e?.cause as string | undefined;
        setNote(
          cause === 'Busy' ? 'الخط مشغول' : cause === 'Canceled' ? 'أُلغيت المكالمة' : cause === 'Unavailable' || cause === 'Not Found' ? 'الرقم غير متاح' : 'لم تكتمل المكالمة',
        );
        reset();
      });
      attachMedia(s);
    },
    [attachMedia, reset, ringer],
  );

  // Keep the latest handlers in a ref so the SIP agent is created once per config.
  const handlers = useRef({ ringer, wireSession });
  handlers.current = { ringer, wireSession };

  // Register the extension's browser account with Asterisk.
  useEffect(() => {
    if (!cfg?.username || !cfg.wsUrl) return;
    setReg('connecting');
    const socket = new JsSIP.WebSocketInterface(cfg.wsUrl);
    const agent = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${cfg.username}@${cfg.domain}`,
      password: cfg.password,
      display_name: cfg.extension?.name,
      register: true,
      session_timers: false,
      user_agent: 'CloudPBX Web',
    });
    agent.on('registered', () => setReg('on'));
    agent.on('unregistered', () => setReg('off'));
    agent.on('registrationFailed', () => setReg('error'));
    agent.on('disconnected', () => setReg('error'));
    agent.on('newRTCSession', (e: any) => {
      if (e.originator !== 'remote') return;
      if (session.current) {
        e.session.terminate({ status_code: 486 });
        return;
      }
      const from = e.request?.from;
      setPeer({ number: from?.uri?.user ?? '', name: from?.display_name });
      setState('incoming');
      setOpen(true);
      handlers.current.ringer.start();
      handlers.current.wireSession(e.session);
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        new Notification('مكالمة واردة', { body: from?.display_name || from?.uri?.user || '' });
      }
    });
    agent.start();
    ua.current = agent;
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    return () => {
      agent.stop();
      ua.current = null;
    };
  }, [cfg]);

  useEffect(() => {
    if (state !== 'active') return;
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(t);
  }, [state]);

  const placeCall = () => {
    const target = dial.replace(/[^\d*#+]/g, '');
    if (!target || !ua.current || reg !== 'on') return;
    setPeer({ number: target });
    setState('calling');
    setNote('جاري الاتصال...');
    const s = ua.current.call(`sip:${target}@${cfg!.domain}`, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    });
    wireSession(s);
  };

  const answer = () => {
    ringer.stop();
    session.current?.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    });
  };

  const hangup = () => {
    try {
      session.current?.terminate();
    } catch {
      reset();
    }
  };

  const toggleMute = () => {
    if (!session.current) return;
    if (muted) session.current.unmute({ audio: true });
    else session.current.mute({ audio: true });
    setMuted(!muted);
  };

  const press = (k: string) => {
    if (state === 'active') session.current?.sendDTMF(k);
    else setDial((d) => (d + k).slice(0, 20));
  };

  if (!cfg) return null;
  if (!cfg.extension) return null;

  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const regLabel = reg === 'on' ? 'متصل وجاهز' : reg === 'connecting' ? 'جاري الاتصال...' : reg === 'error' ? 'غير متصل' : 'متوقف';
  const expanded = open || state !== 'idle';

  return (
    <section className={`phone ${state === 'incoming' ? 'incoming' : ''}`} aria-label="هاتف المتصفح">
      <audio ref={audio} autoPlay />
      <div className="phone-bar" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0} aria-expanded={expanded}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen((o) => !o)}>
        <span className={`reg ${reg === 'on' ? 'on' : reg === 'error' ? 'err' : ''}`} aria-hidden="true" />
        <div className="who">
          <b>تحويلتك {cfg.extension.number}</b>
          <span>{state === 'active' ? `في مكالمة ${mmss}` : state === 'incoming' ? 'مكالمة واردة' : regLabel}</span>
        </div>
        {Icon.phone(20)}
      </div>

      {expanded && (
        <div className="phone-body">
          {state === 'idle' && (
            <>
              <input
                className="phone-display"
                value={dial}
                onChange={(e) => setDial(e.target.value.replace(/[^\d*#+]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && placeCall()}
                placeholder="رقم الجوال أو التحويلة"
                inputMode="tel"
                aria-label="الرقم"
              />
              <div className="pad">
                {KEYS.map(([k, sub]) => (
                  <button key={k} type="button" onClick={() => press(k)}>
                    {k}
                    {sub && <small>{sub}</small>}
                  </button>
                ))}
              </div>
              <div className="call-actions">
                <button className="round go" type="button" onClick={placeCall} disabled={!dial || reg !== 'on'} aria-label="اتصال">
                  {Icon.phone(24)}
                </button>
                {dial && (
                  <button className="round tool" type="button" onClick={() => setDial((d) => d.slice(0, -1))} aria-label="مسح رقم">
                    ⌫
                  </button>
                )}
              </div>
              {note && <p className="phone-note">{note}</p>}
              {reg === 'error' && <p className="phone-note">تعذّر الاتصال بالسنترال. تأكد من الإنترنت وحدّث الصفحة.</p>}
            </>
          )}

          {state !== 'idle' && (
            <>
              <div className="call-state">
                <div className="peer">{fmtPhone(peer.number) === 'غير معروف' ? peer.number : fmtPhone(peer.number)}</div>
                {peer.name && peer.name !== peer.number && <div className="peer-name">{peer.name}</div>}
                <div className="timer">{state === 'active' ? mmss : state === 'incoming' ? 'يتصل بك' : note}</div>
              </div>
              {state === 'active' && showPad && (
                <div className="pad">
                  {KEYS.map(([k]) => (
                    <button key={k} type="button" onClick={() => press(k)}>{k}</button>
                  ))}
                </div>
              )}
              <div className="call-actions">
                {state === 'active' && (
                  <>
                    <button className={`round tool ${muted ? 'on' : ''}`} type="button" onClick={toggleMute} aria-pressed={muted} aria-label="كتم الصوت">
                      {Icon.mic()}
                    </button>
                    <button className={`round tool ${showPad ? 'on' : ''}`} type="button" onClick={() => setShowPad((p) => !p)} aria-pressed={showPad} aria-label="لوحة الأرقام">
                      {Icon.keypad()}
                    </button>
                  </>
                )}
                {state === 'incoming' && (
                  <button className="round go" type="button" onClick={answer} aria-label="رد">
                    {Icon.phone(24)}
                  </button>
                )}
                <button className="round end" type="button" onClick={hangup} aria-label="إنهاء">
                  {Icon.hangup()}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
