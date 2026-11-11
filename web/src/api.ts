export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('pbx:logout'));
    throw new ApiError(res.status, data?.message ?? 'صار خطأ، حاول مرة ثانية');
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};

export type HumanDestination =
  | { type: 'extension'; id: string }
  | { type: 'ring_group'; id: string }
  | { type: 'ivr'; id: string }
  | { type: 'voicemail'; id: string }
  | { type: 'hangup' };

export type Destination =
  | HumanDestination
  | { type: 'ai_receptionist'; fallback?: HumanDestination };

export interface Me {
  user: { id: string; name: string; email: string; role: 'owner' | 'admin' | 'agent' | 'superadmin'; tenant_id: string | null };
  tenant: { id: string; name: string; slug: string; timezone: string } | null;
  extension: { id: string; number: string; name: string } | null;
  allowSignup: boolean;
  features?: { aiReceptionist: boolean };
}

export interface Extension {
  id: string;
  number: string;
  name: string;
  user_id: string | null;
  voicemail_enabled: boolean;
  outbound_allowed: boolean;
  sip_username: string;
  sip_password?: string;
  sip_domain?: string;
  sip_port?: number;
  online?: boolean;
}

export interface RingGroup {
  id: string;
  name: string;
  number: string | null;
  strategy: 'simultaneous' | 'sequential';
  ring_seconds: number;
  member_ids: string[];
  fallback: Destination;
}

export interface Ivr {
  id: string;
  name: string;
  greeting_id: string | null;
  options: Record<string, Destination>;
  allow_direct_dial: boolean;
  timeout_s: number;
  timeout_dest: Destination;
}

export interface AudioFile {
  id: string;
  name: string;
  duration_s: number | null;
  created_at: string;
}

export interface PhoneNumber {
  id: string;
  e164: string;
  label: string | null;
  destination: Destination;
  after_hours_dest: Destination | null;
  business_hours: Record<string, [string, string][]> | null;
}

export interface Call {
  id: string;
  direction: 'inbound' | 'outbound' | 'internal';
  from_number: string | null;
  from_name: string | null;
  to_number: string | null;
  status: string;
  started_at: string;
  duration_s: number | null;
  has_recording: boolean;
  ext_number: string | null;
  ext_name: string | null;
  answered_number: string | null;
  answered_name: string | null;
  hangup_cause: string | null;
  handled_by_ai?: boolean;
  external_ref?: string | null;
  transferred_at?: string | null;
}
