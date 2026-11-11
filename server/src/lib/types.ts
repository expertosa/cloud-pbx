import { z } from 'zod';

const extensionDest = z.object({ type: z.literal('extension'), id: z.uuid() });
const ringGroupDest = z.object({ type: z.literal('ring_group'), id: z.uuid() });
const ivrDest = z.object({ type: z.literal('ivr'), id: z.uuid() });
const voicemailDest = z.object({ type: z.literal('voicemail'), id: z.uuid() });
const hangupDest = z.object({ type: z.literal('hangup') });

/** Destinations a human (or the existing IVR/voicemail path) can receive. No nesting. */
export const humanDestinationSchema = z.discriminatedUnion('type', [extensionDest, ringGroupDest, ivrDest, voicemailDest, hangupDest]);
export type HumanDestination = z.infer<typeof humanDestinationSchema>;

export const destinationSchema = z.discriminatedUnion('type', [
  extensionDest,
  ringGroupDest,
  ivrDest,
  voicemailDest,
  hangupDest,
  z.object({
    type: z.literal('ai_receptionist'),
    /** Used when the media service is down, the flag is off, or the caller is handed back with no explicit target. */
    fallback: humanDestinationSchema.optional(),
  }),
]);
export type Destination = z.infer<typeof destinationSchema>;

export const businessHoursSchema = z.partialRecord(
  z.enum(['0', '1', '2', '3', '4', '5', '6']),
  z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])),
);

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  record_calls: boolean;
  allow_international: boolean;
  allowed_country_codes: string[];
  outbound_caller_id: string | null;
  daily_outbound_minutes: number;
  webhook_url: string | null;
  webhook_secret: string;
  disabled: boolean;
}

export interface Extension {
  id: string;
  tenant_id: string;
  number: string;
  name: string;
  user_id: string | null;
  sip_username: string;
  sip_password: string;
  web_username: string;
  web_password: string;
  voicemail_enabled: boolean;
  outbound_allowed: boolean;
}

export interface RingGroup {
  id: string;
  tenant_id: string;
  name: string;
  number: string | null;
  strategy: 'simultaneous' | 'sequential';
  ring_seconds: number;
  member_ids: string[];
  fallback: Destination;
}

export interface Ivr {
  id: string;
  tenant_id: string;
  name: string;
  greeting_id: string | null;
  options: Record<string, Destination>;
  allow_direct_dial: boolean;
  timeout_s: number;
  timeout_dest: Destination;
}

export interface PhoneNumber {
  id: string;
  tenant_id: string | null;
  e164: string;
  label: string | null;
  destination: Destination;
  after_hours_dest: Destination | null;
  business_hours: Record<string, [string, string][]> | null;
}
