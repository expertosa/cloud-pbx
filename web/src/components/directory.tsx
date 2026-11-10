import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Destination, type Extension, type Ivr, type RingGroup } from '../api';

interface Directory {
  extensions: Extension[];
  groups: RingGroup[];
  ivrs: Ivr[];
  aiReceptionist: boolean;
  reload: () => Promise<void>;
}

const Ctx = createContext<Directory>({ extensions: [], groups: [], ivrs: [], aiReceptionist: false, reload: async () => {} });

/** Extensions, ring groups and IVRs of the company — shared by every routing picker. */
export function DirectoryProvider({ children, aiReceptionist = false }: { children: ReactNode; aiReceptionist?: boolean }) {
  const [state, setState] = useState<Pick<Directory, 'extensions' | 'groups' | 'ivrs'>>({ extensions: [], groups: [], ivrs: [] });
  const reload = useCallback(async () => {
    const [extensions, groups, ivrs] = await Promise.all([
      api.get<Extension[]>('/api/extensions'),
      api.get<RingGroup[]>('/api/ring-groups'),
      api.get<Ivr[]>('/api/ivrs'),
    ]);
    setState({ extensions, groups, ivrs });
  }, []);
  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);
  return <Ctx.Provider value={{ ...state, aiReceptionist, reload }}>{children}</Ctx.Provider>;
}

export const useDirectory = () => useContext(Ctx);

export function destinationLabel(d: Destination | null | undefined, dir: Directory): string {
  if (!d) return '—';
  switch (d.type) {
    case 'hangup':
      return 'إنهاء المكالمة';
    case 'extension': {
      const e = dir.extensions.find((x) => x.id === d.id);
      return e ? `${e.name} (${e.number})` : 'تحويلة محذوفة';
    }
    case 'voicemail': {
      const e = dir.extensions.find((x) => x.id === d.id);
      return e ? `البريد الصوتي لـ ${e.name}` : 'بريد صوتي محذوف';
    }
    case 'ring_group': {
      const g = dir.groups.find((x) => x.id === d.id);
      return g ? `مجموعة ${g.name}` : 'مجموعة محذوفة';
    }
    case 'ivr': {
      const i = dir.ivrs.find((x) => x.id === d.id);
      return i ? `الرد الآلي: ${i.name}` : 'رد آلي محذوف';
    }
    case 'ai_receptionist':
      return `الموظف الذكي ← ${destinationLabel(d.fallback, dir)}`;
  }
}

const encode = (d: Destination) => (d.type === 'hangup' || d.type === 'ai_receptionist' ? d.type : `${d.type}:${d.id}`);
const decode = (v: string): Destination => {
  if (v === 'hangup') return { type: 'hangup' };
  if (v === 'ai_receptionist') return { type: 'ai_receptionist', fallback: { type: 'hangup' } };
  const sep = v.indexOf(':');
  return { type: v.slice(0, sep), id: v.slice(sep + 1) } as Destination;
};

/** One <select> covering every place a call can be sent. */
export function DestinationPicker({
  value,
  onChange,
  exclude,
  id,
  allowAi = true,
}: {
  value: Destination;
  onChange: (d: Destination) => void;
  exclude?: string;
  id?: string;
  /** Nested fallback picker must not offer the receptionist again. */
  allowAi?: boolean;
}) {
  const dir = useDirectory();
  const showAi = allowAi && (dir.aiReceptionist || value.type === 'ai_receptionist');
  const fallback = value.type === 'ai_receptionist' ? (value.fallback ?? { type: 'hangup' as const }) : null;
  return (
    <>
      <select id={id} value={encode(value)} onChange={(e) => onChange(decode(e.target.value))} aria-label={id ? undefined : 'وجهة المكالمة'}>
        {dir.ivrs.length > 0 && (
          <optgroup label="الرد الآلي">
            {dir.ivrs.filter((i) => i.id !== exclude).map((i) => (
              <option key={i.id} value={`ivr:${i.id}`}>{i.name}</option>
            ))}
          </optgroup>
        )}
        {dir.groups.length > 0 && (
          <optgroup label="مجموعات الرنين">
            {dir.groups.filter((g) => g.id !== exclude).map((g) => (
              <option key={g.id} value={`ring_group:${g.id}`}>{g.name}{g.number ? ` (${g.number})` : ''}</option>
            ))}
          </optgroup>
        )}
        <optgroup label="موظف">
          {dir.extensions.map((e) => (
            <option key={e.id} value={`extension:${e.id}`}>{e.name} ({e.number})</option>
          ))}
        </optgroup>
        <optgroup label="بريد صوتي">
          {dir.extensions.map((e) => (
            <option key={e.id} value={`voicemail:${e.id}`}>بريد {e.name}</option>
          ))}
        </optgroup>
        {showAi && <option value="ai_receptionist">الموظف الذكي</option>}
        <option value="hangup">إنهاء المكالمة</option>
      </select>
      {fallback && (
        <>
          <span className="hint">إذا تعذّر الموظف الذكي، أو طلب تحويلاً بدون وجهة، تروح المكالمة إلى</span>
          <DestinationPicker allowAi={false} value={fallback} onChange={(d) => onChange({ type: 'ai_receptionist', fallback: d.type === 'ai_receptionist' ? { type: 'hangup' } : d })} />
        </>
      )}
    </>
  );
}
