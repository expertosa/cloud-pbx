import crypto from 'node:crypto';
import path from 'node:path';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { isOpen } from '../lib/hours.js';
import { logger } from '../lib/logger.js';
import { isAllowedDestination, isBlockedPremium, normalizeDid, normalizeDialed } from '../lib/phone.js';
import type { Destination, Extension, Ivr, PhoneNumber, RingGroup, Tenant } from '../lib/types.js';
import { sendWebhook } from '../lib/webhooks.js';
import { ari } from './ari.js';

/* -------------------------------------------------------------------------- */
/*  Call engine                                                               */
/*                                                                            */
/*  Every call enters the Stasis app "cloudpbx". The caller's channel stays   */
/*  under our control; we ring extensions by originating "legs" into the      */
/*  same app. The first leg to answer is bridged with the caller, the rest    */
/*  are hung up. IVR, voicemail and recordings are driven over ARI.           */
/* -------------------------------------------------------------------------- */

const RING_SECONDS = 25;
const MAX_DEST_HOPS = 8;

type DialResult = 'answered' | 'noanswer' | 'gone';

interface Leg {
  id: string;
  session: Session;
  endpoint: string;
  extId: string | null;
  gone: boolean;
}

interface DialAttempt {
  legs: Set<string>;
  resolve: (r: DialResult) => void;
  timer?: NodeJS.Timeout;
  done: boolean;
}

const sessionsByCaller = new Map<string, Session>();
const sessionsById = new Map<string, Session>();
const legs = new Map<string, Leg>();
const playbackWaiters = new Map<string, () => void>();
const recordingWaiters = new Map<string, (ev: any) => void>();

export function prompt(name: string): string {
  return `sound:${path.join(config.promptsDir, name)}`;
}

function endpointOfChannel(name: string): string {
  // "PJSIP/acme-101-00000003" -> "acme-101"
  const afterTech = name.slice(name.indexOf('/') + 1);
  const dash = afterTech.lastIndexOf('-');
  return dash > 0 ? afterTech.slice(0, dash) : afterTech;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class Session {
  readonly id = crypto.randomUUID();
  callerAnswered = false;
  gone = false;
  connected = false;
  bridgeId?: string;
  recordingName?: string;
  status: string = 'ringing';
  answeredBy: string | null = null;
  private answeredLegId: string | null = null;
  answeredAt?: Date;
  /** The extension that placed an internal/outbound call (never rung back). */
  originExtId: string | null = null;
  private dtmf = '';
  private dtmfListener?: () => void;
  private dialing?: DialAttempt;
  private goneWaiters: (() => void)[] = [];
  private connectedEnd?: () => void;
  private finalized = false;

  constructor(
    public tenant: Tenant,
    public callerChannel: any,
    public direction: 'inbound' | 'outbound' | 'internal',
  ) {
    sessionsByCaller.set(callerChannel.id, this);
    sessionsById.set(this.id, this);
  }

  get callerId() {
    return this.callerChannel.id as string;
  }

  log(msg: string, extra: Record<string, unknown> = {}) {
    logger.info({ call: this.id, tenant: this.tenant.slug, ...extra }, msg);
  }

  /** Resolves when the caller has hung up. */
  whenGone(): Promise<void> {
    if (this.gone) return Promise.resolve();
    return new Promise((r) => this.goneWaiters.push(r));
  }

  async answer() {
    if (this.callerAnswered || this.gone) return;
    await ari.quiet(() => ari.post(`/channels/${this.callerId}/answer`));
    this.callerAnswered = true;
  }

  async ring() {
    if (this.callerAnswered || this.gone) return;
    await ari.quiet(() => ari.post(`/channels/${this.callerId}/ring`));
  }

  /** Play a sound; resolves when finished, interrupted by DTMF (if interruptible) or caller gone. */
  async play(media: string, interruptible = false): Promise<void> {
    if (this.gone) return;
    await this.answer();
    if (interruptible && this.dtmf.length > 0) return;
    const playbackId = crypto.randomUUID();
    const finished = new Promise<void>((resolve) => playbackWaiters.set(playbackId, resolve));
    try {
      await ari.post(`/channels/${this.callerId}/play/${playbackId}`, { media, lang: 'ar' });
    } catch (e) {
      playbackWaiters.delete(playbackId);
      this.log('playback failed', { media, err: String(e) });
      return;
    }
    const stopOnDtmf = interruptible
      ? new Promise<void>((resolve) => {
          this.dtmfListener = resolve;
        })
      : new Promise<void>(() => {});
    await Promise.race([finished, stopOnDtmf, this.whenGone()]);
    this.dtmfListener = undefined;
    playbackWaiters.delete(playbackId);
    await ari.quiet(() => ari.del(`/playbacks/${playbackId}`));
  }

  onDtmf(digit: string) {
    this.dtmf += digit;
    const l = this.dtmfListener;
    this.dtmfListener = undefined;
    l?.();
  }

  clearDtmf() {
    this.dtmf = '';
  }

  /**
   * Collect up to `max` digits. Waits `firstMs` for the first digit and `interMs`
   * between digits. Digits pressed during an interruptible prompt are included.
   */
  async collect(max: number, firstMs: number, interMs: number): Promise<string> {
    const waitDigit = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (this.gone) return resolve(false);
        const t = setTimeout(() => {
          this.dtmfListener = undefined;
          resolve(false);
        }, ms);
        this.dtmfListener = () => {
          clearTimeout(t);
          resolve(true);
        };
        this.whenGone().then(() => {
          clearTimeout(t);
          resolve(false);
        });
      });
    if (this.dtmf.length === 0) await waitDigit(firstMs);
    while (!this.gone && this.dtmf.length > 0 && this.dtmf.length < max && !this.dtmf.endsWith('#')) {
      if (!(await waitDigit(interMs))) break;
    }
    const got = this.dtmf.replace(/#$/, '').slice(0, max);
    this.dtmf = '';
    return got;
  }

  /* ---------------------------- ringing extensions --------------------------- */

  async dial(targets: { endpoint: string; extId: string | null }[], timeoutSec: number, callerId: string): Promise<DialResult> {
    if (this.gone) return 'gone';
    if (targets.length === 0) return 'noanswer';
    const attempt: DialAttempt = { legs: new Set(), resolve: () => {}, done: false };
    const result = new Promise<DialResult>((resolve) => {
      attempt.resolve = (r) => {
        if (attempt.done) return;
        attempt.done = true;
        if (attempt.timer) clearTimeout(attempt.timer);
        resolve(r);
      };
    });
    this.dialing = attempt;

    for (const t of targets) {
      const legId = `leg-${crypto.randomUUID()}`;
      const leg: Leg = { id: legId, session: this, endpoint: t.endpoint, extId: t.extId, gone: false };
      legs.set(legId, leg);
      attempt.legs.add(legId);
      try {
        await ari.post('/channels', {
          endpoint: t.endpoint,
          app: config.ari.app,
          appArgs: `leg,${this.id}`,
          channelId: legId,
          callerId,
          timeout: timeoutSec,
          originator: this.callerId,
        });
      } catch (e) {
        // "Allocation failed" just means that phone is not registered right now.
        if (!String(e).includes('Allocation failed')) this.log('leg originate failed', { endpoint: t.endpoint, err: String(e) });
        leg.gone = true;
        legs.delete(legId);
        attempt.legs.delete(legId);
      }
    }
    if (attempt.legs.size === 0) attempt.resolve('noanswer');
    else {
      void this.ring();
      attempt.timer = setTimeout(() => {
        this.hangupLegs(attempt);
        attempt.resolve('noanswer');
      }, (timeoutSec + 2) * 1000);
    }
    this.whenGone().then(() => attempt.resolve('gone'));
    const r = await result;
    if (r !== 'answered') this.hangupLegs(attempt);
    if (this.dialing === attempt) this.dialing = undefined;
    return r;
  }

  private hangupLegs(attempt: DialAttempt, except?: string) {
    for (const id of attempt.legs) {
      if (id === except) continue;
      void ari.quiet(() => ari.del(`/channels/${id}`, { reason: 'normal' }));
    }
  }

  async onLegAnswered(leg: Leg) {
    const attempt = this.dialing;
    if (this.gone || this.connected || !attempt || attempt.done || !attempt.legs.has(leg.id)) {
      await ari.quiet(() => ari.del(`/channels/${leg.id}`));
      return;
    }
    this.connected = true;
    this.answeredLegId = leg.id;
    this.hangupLegs(attempt, leg.id);
    try {
      await this.answer();
      const bridge = await ari.post('/bridges', { type: 'mixing', name: `call-${this.id}` });
      this.bridgeId = bridge.id;
      if (this.gone) {
        // Caller hung up while the leg was being answered.
        await ari.quiet(() => ari.del(`/bridges/${bridge.id}`));
        await ari.quiet(() => ari.del(`/channels/${leg.id}`));
        attempt.resolve('gone');
        return;
      }
      await ari.post(`/bridges/${bridge.id}/addChannel`, { channel: `${this.callerId},${leg.id}` });
      this.status = 'answered';
      this.answeredBy = leg.extId;
      this.answeredAt = new Date();
      await q('update calls set status=$2, answered_at=now(), answered_by=$3 where id=$1', [this.id, 'answered', leg.extId]);
      if (this.tenant.record_calls) {
        const name = `call-${this.id}`;
        await ari
          .post(`/bridges/${bridge.id}/record`, { name, format: 'wav', ifExists: 'overwrite' })
          .then(() => (this.recordingName = name))
          .catch((e) => this.log('recording failed', { err: String(e) }));
      }
      this.log('call connected', { endpoint: leg.endpoint });
      sendWebhook(this.tenant, 'call.answered', { call_id: this.id, answered_by: leg.extId });
    } catch (e) {
      this.log('failed to connect call', { err: String(e) });
      await ari.quiet(() => ari.del(`/channels/${leg.id}`));
      this.connected = false;
      this.answeredLegId = null;
      attempt.resolve('noanswer');
      return;
    }
    attempt.resolve('answered');
  }

  /** After a successful dial(): resolves when either side of the bridged call hangs up. */
  async untilCallEnds(): Promise<void> {
    if (this.gone) return;
    await new Promise<void>((resolve) => {
      this.connectedEnd = resolve;
      this.whenGone().then(resolve);
    });
  }

  onLegGone(leg: Leg) {
    leg.gone = true;
    legs.delete(leg.id);
    if (this.connected && this.answeredLegId === leg.id) {
      // The answered party hung up: end the call for the caller too.
      this.connectedEnd?.();
      void ari.quiet(() => ari.del(`/channels/${this.callerId}`));
      return;
    }
    const attempt = this.dialing;
    if (attempt && !attempt.done) {
      attempt.legs.delete(leg.id);
      if (attempt.legs.size === 0) attempt.resolve('noanswer');
    }
  }

  onCallerGone(cause?: string) {
    if (this.gone) return;
    this.gone = true;
    const ws = this.goneWaiters.splice(0);
    ws.forEach((w) => w());
    this.connectedEnd?.();
    void this.finalize(cause);
  }

  async hangup() {
    await ari.quiet(() => ari.del(`/channels/${this.callerId}`));
  }

  private async finalize(cause?: string) {
    if (this.finalized) return;
    this.finalized = true;
    if (this.dialing) this.hangupLegs(this.dialing);
    for (const [id, leg] of legs) if (leg.session === this) void ari.quiet(() => ari.del(`/channels/${id}`));
    if (this.bridgeId) void ari.quiet(() => ari.del(`/bridges/${this.bridgeId}`));
    sessionsByCaller.delete(this.callerId);
    sessionsById.delete(this.id);

    let status = this.status;
    if (status === 'ringing') status = this.direction === 'inbound' ? 'missed' : 'abandoned';
    const duration = this.answeredAt ? Math.round((Date.now() - this.answeredAt.getTime()) / 1000) : null;
    const row = await one(
      `update calls set status=$2, ended_at=now(), duration_s=$3, hangup_cause=coalesce(hangup_cause, $4), recording_path=$5 where id=$1 returning *`,
      [this.id, status, duration, cause ?? null, this.recordingName ?? null],
    ).catch((e) => {
      logger.error({ err: String(e) }, 'failed to finalize call');
      return null;
    });
    this.log('call ended', { status, duration });
    if (row) sendWebhook(this.tenant, 'call.ended', row);
  }

  /* -------------------------------- voicemail -------------------------------- */

  async voicemail(ext: Extension): Promise<void> {
    if (this.gone) return;
    await this.answer();
    await sleep(300);
    this.clearDtmf();
    await this.play(prompt('vm-greeting'), true);
    if (this.gone) return;
    this.clearDtmf();
    await this.play(prompt('beep'));
    if (this.gone) return;
    const name = `vm-${crypto.randomUUID()}`;
    const done = new Promise<any>((resolve) => recordingWaiters.set(name, resolve));
    try {
      await ari.post(`/channels/${this.callerId}/record`, {
        name,
        format: 'wav',
        maxDurationSeconds: config.voicemailMaxSeconds,
        maxSilenceSeconds: 8,
        ifExists: 'overwrite',
        beep: false,
        terminateOn: '#',
      });
    } catch (e) {
      recordingWaiters.delete(name);
      this.log('voicemail record failed', { err: String(e) });
      return;
    }
    const ev = await done;
    recordingWaiters.delete(name);
    const duration = Number(ev?.recording?.duration ?? 0);
    if (duration < 1) {
      this.log('voicemail empty, discarded');
      return;
    }
    this.status = 'voicemail';
    const vm = await one(
      `insert into voicemails(tenant_id, extension_id, call_id, caller, path, duration_s) values ($1,$2,$3,$4,$5,$6) returning *`,
      [this.tenant.id, ext.id, this.id, this.callerChannel.caller?.number || null, name, duration],
    );
    await q('update calls set status=$2 where id=$1', [this.id, 'voicemail']);
    this.log('voicemail saved', { ext: ext.number, duration });
    sendWebhook(this.tenant, 'voicemail.created', vm);
    if (!this.gone) {
      await this.play(prompt('vm-saved'));
      await this.hangup();
    }
  }
}

/* ------------------------------ lookups ------------------------------------ */

function extTargets(ext: Extension) {
  return [
    { endpoint: `PJSIP/${ext.web_username}`, extId: ext.id },
    { endpoint: `PJSIP/${ext.sip_username}`, extId: ext.id },
  ];
}

async function getExtension(tenantId: string, id: string) {
  return one<Extension>('select * from extensions where tenant_id=$1 and id=$2', [tenantId, id]);
}

function callerIdFor(session: Session): string {
  const c = session.callerChannel.caller ?? {};
  const num = c.number || 'unknown';
  const name = (c.name || num).replace(/"/g, '');
  return `"${name}" <${num}>`;
}

/* -------------------------- destination routing ---------------------------- */

async function runDestination(s: Session, dest: Destination, hops = 0): Promise<void> {
  if (s.gone) return;
  if (hops > MAX_DEST_HOPS) {
    s.log('too many routing hops, hanging up');
    return s.hangup();
  }
  switch (dest.type) {
    case 'extension': {
      const ext = await getExtension(s.tenant.id, dest.id);
      if (!ext) return s.hangup();
      return ringExtension(s, ext, hops);
    }
    case 'ring_group': {
      const g = await one<RingGroup>('select * from ring_groups where tenant_id=$1 and id=$2', [s.tenant.id, dest.id]);
      if (!g) return s.hangup();
      return ringGroup(s, g, hops);
    }
    case 'ivr': {
      const ivr = await one<Ivr>('select * from ivrs where tenant_id=$1 and id=$2', [s.tenant.id, dest.id]);
      if (!ivr) return s.hangup();
      return runIvr(s, ivr, hops);
    }
    case 'voicemail': {
      const ext = await getExtension(s.tenant.id, dest.id);
      if (!ext) return s.hangup();
      await s.voicemail(ext);
      return s.hangup();
    }
    case 'hangup':
    default:
      return s.hangup();
  }
}

async function ringExtension(s: Session, ext: Extension, hops: number) {
  s.log('ringing extension', { ext: ext.number });
  const r = await s.dial(extTargets(ext), RING_SECONDS, callerIdFor(s));
  if (r === 'answered') return s.untilCallEnds().then(() => s.hangup());
  if (r === 'gone') return;
  if (ext.voicemail_enabled) {
    await s.voicemail(ext);
    return s.hangup();
  }
  await s.play(prompt('unavailable'));
  return s.hangup();
}

async function ringGroup(s: Session, g: RingGroup, hops: number) {
  const members = (
    await q<Extension>('select * from extensions where tenant_id=$1 and id = any($2::uuid[])', [s.tenant.id, g.member_ids])
  )
    .filter((m) => m.id !== s.originExtId)
    .sort((a, b) => g.member_ids.indexOf(a.id) - g.member_ids.indexOf(b.id));
  s.log('ringing group', { group: g.name, members: members.length, strategy: g.strategy });
  const cid = callerIdFor(s);
  if (g.strategy === 'sequential') {
    for (const m of members) {
      const r = await s.dial(extTargets(m), g.ring_seconds, cid);
      if (r === 'answered') return s.untilCallEnds().then(() => s.hangup());
      if (r === 'gone') return;
    }
  } else {
    const r = await s.dial(members.flatMap(extTargets), g.ring_seconds, cid);
    if (r === 'answered') return s.untilCallEnds().then(() => s.hangup());
    if (r === 'gone') return;
  }
  return runDestination(s, g.fallback, hops + 1);
}

async function runIvr(s: Session, ivr: Ivr, hops: number) {
  await s.answer();
  await sleep(500);
  s.clearDtmf();
  let greeting = prompt('ivr-default');
  if (ivr.greeting_id) {
    const a = await one('select path from audio_files where id=$1 and tenant_id=$2', [ivr.greeting_id, s.tenant.id]);
    if (a) greeting = `sound:${a.path}`;
  }
  const maxLen = ivr.allow_direct_dial ? 5 : 1;
  for (let attempt = 0; attempt < 3 && !s.gone; attempt++) {
    await s.play(greeting, true);
    const digits = await s.collect(maxLen, ivr.timeout_s * 1000, 2500);
    if (s.gone) return;
    if (!digits) continue; // replay greeting
    s.log('ivr input', { digits });
    const opt = ivr.options[digits];
    if (opt) return runDestination(s, opt, hops + 1);
    if (ivr.allow_direct_dial) {
      const ext = await one<Extension>('select * from extensions where tenant_id=$1 and number=$2', [s.tenant.id, digits]);
      if (ext) return ringExtension(s, ext, hops + 1);
      const g = await one<RingGroup>('select * from ring_groups where tenant_id=$1 and number=$2', [s.tenant.id, digits]);
      if (g) return ringGroup(s, g, hops + 1);
    }
    await s.play(prompt('invalid'));
  }
  return runDestination(s, ivr.timeout_dest, hops + 1);
}

/* ------------------------------- entry points ------------------------------ */

async function handleInbound(channel: any, args: string[]) {
  const candidates = [args[1], args[2], channel.dialplan?.exten].map((x) => normalizeDid(x)).filter(Boolean) as string[];
  let number: (PhoneNumber & { tenant_id: string }) | null = null;
  for (const c of candidates) {
    number = await one('select * from phone_numbers where e164=$1 and tenant_id is not null', [c]);
    if (number) break;
  }
  if (!number) {
    logger.warn({ candidates, from: channel.caller?.number }, 'inbound call to unknown number');
    await ari.quiet(() => ari.del(`/channels/${channel.id}`, { reason: 'unallocated' }));
    return;
  }
  const tenant = await one<Tenant>('select * from tenants where id=$1', [number.tenant_id]);
  if (!tenant || tenant.disabled) {
    await ari.quiet(() => ari.del(`/channels/${channel.id}`, { reason: 'unallocated' }));
    return;
  }
  const s = new Session(tenant, channel, 'inbound');
  await q(
    `insert into calls(id, tenant_id, direction, from_number, from_name, to_number, did, channel_id) values ($1,$2,'inbound',$3,$4,$5,$5,$6)`,
    [s.id, tenant.id, channel.caller?.number || null, channel.caller?.name || null, number.e164, channel.id],
  );
  s.log('inbound call', { did: number.e164, from: channel.caller?.number });
  sendWebhook(tenant, 'call.started', { call_id: s.id, direction: 'inbound', from: channel.caller?.number, to: number.e164 });

  let dest = number.destination;
  if (number.business_hours && number.after_hours_dest && !isOpen(number.business_hours, tenant.timezone)) {
    s.log('outside business hours');
    dest = number.after_hours_dest;
  }
  await runDestination(s, dest);
}

async function outboundAllowed(tenant: Tenant, ext: Extension, e164: string): Promise<string | null> {
  if (!ext.outbound_allowed) return 'extension not allowed to dial out';
  if (!tenant.outbound_caller_id) return 'tenant has no outbound caller id';
  if (isBlockedPremium(e164)) return 'premium/high-risk destination';
  const inAllowed = isAllowedDestination(e164, tenant.allowed_country_codes);
  if (!inAllowed && !tenant.allow_international) return 'destination country not allowed';
  const used = await one<{ minutes: number }>(
    `select coalesce(sum(duration_s),0)/60.0 as minutes from calls where tenant_id=$1 and direction='outbound' and started_at > now() - interval '1 day'`,
    [tenant.id],
  );
  if (used && Number(used.minutes) >= tenant.daily_outbound_minutes) return 'daily outbound minutes limit reached';
  return null;
}

async function handleInternal(channel: any, args: string[]) {
  const endpoint = endpointOfChannel(channel.name);
  const ext = await one<Extension>('select * from extensions where sip_username=$1 or web_username=$1', [endpoint]);
  if (!ext) {
    logger.warn({ endpoint }, 'call from unknown endpoint');
    await ari.quiet(() => ari.del(`/channels/${channel.id}`));
    return;
  }
  const tenant = await one<Tenant>('select * from tenants where id=$1', [ext.tenant_id]);
  if (!tenant || tenant.disabled) {
    await ari.quiet(() => ari.del(`/channels/${channel.id}`));
    return;
  }
  const dialed = String(args[1] ?? channel.dialplan?.exten ?? '');
  // Present the caller as the extension, not the raw endpoint name.
  channel.caller = { name: ext.name, number: ext.number };

  const target = await one<Extension>('select * from extensions where tenant_id=$1 and number=$2', [tenant.id, dialed]);
  const group = target ? null : await one<RingGroup>('select * from ring_groups where tenant_id=$1 and number=$2', [tenant.id, dialed]);
  if (target || group) {
    const s = new Session(tenant, channel, 'internal');
    s.originExtId = ext.id;
    await q(
      `insert into calls(id, tenant_id, direction, from_number, from_name, to_number, extension_id, channel_id) values ($1,$2,'internal',$3,$4,$5,$6,$7)`,
      [s.id, tenant.id, ext.number, ext.name, dialed, ext.id, channel.id],
    );
    if (target) {
      if (target.id === ext.id) return s.hangup();
      return ringExtension(s, target, 0);
    }
    return ringGroup(s, group!, 0);
  }

  const e164 = normalizeDialed(dialed);
  if (!e164) {
    logger.info({ dialed, ext: ext.number }, 'dialed number not recognised');
    await ari.quiet(() => ari.del(`/channels/${channel.id}`, { reason: 'unallocated' }));
    return;
  }
  const s = new Session(tenant, channel, 'outbound');
  s.originExtId = ext.id;
  await q(
    `insert into calls(id, tenant_id, direction, from_number, from_name, to_number, extension_id, channel_id) values ($1,$2,'outbound',$3,$4,$5,$6,$7)`,
    [s.id, tenant.id, tenant.outbound_caller_id, ext.name, e164, ext.id, channel.id],
  );
  const reason = await outboundAllowed(tenant, ext, e164);
  if (reason) {
    s.log('outbound call blocked', { to: e164, reason });
    s.status = 'rejected';
    await q('update calls set status=$2, hangup_cause=$3 where id=$1', [s.id, 'rejected', reason]);
    await s.play(prompt('outbound-blocked'));
    return s.hangup();
  }
  const dialNumber = config.trunkNumberFormat === 'e164' ? e164.slice(1) : e164;
  s.log('outbound call', { to: e164, ext: ext.number });
  sendWebhook(tenant, 'call.started', { call_id: s.id, direction: 'outbound', from: ext.number, to: e164 });
  const r = await s.dial(
    [{ endpoint: `PJSIP/${dialNumber}@${config.trunkEndpoint}`, extId: null }],
    60,
    `"${tenant.name.replace(/"/g, '')}" <${tenant.outbound_caller_id}>`,
  );
  if (r === 'answered') {
    await s.untilCallEnds();
    return s.hangup();
  }
  if (r !== 'gone') {
    s.status = 'failed';
    await q('update calls set status=$2 where id=$1', [s.id, 'failed']);
  }
  return s.hangup();
}

/* ------------------------------ event wiring ------------------------------- */

export function startCallEngine() {
  ari.on('StasisStart', async (ev: any) => {
    const ch = ev.channel;
    const args: string[] = ev.args ?? [];
    try {
      if (args[0] === 'leg') {
        const leg = legs.get(ch.id);
        if (!leg) {
          await ari.quiet(() => ari.del(`/channels/${ch.id}`));
          return;
        }
        await leg.session.onLegAnswered(leg);
        return;
      }
      if (args[0] === 'inbound') return await handleInbound(ch, args);
      if (args[0] === 'internal') return await handleInternal(ch, args);
      logger.warn({ args }, 'unknown StasisStart');
      await ari.quiet(() => ari.del(`/channels/${ch.id}`));
    } catch (e) {
      logger.error({ err: String(e), stack: (e as Error).stack }, 'call handling failed');
      await ari.quiet(() => ari.del(`/channels/${ch.id}`));
    }
  });

  const onGone = (ev: any) => {
    const id = ev.channel?.id;
    if (!id) return;
    const s = sessionsByCaller.get(id);
    if (s) s.onCallerGone(ev.cause_txt);
    const leg = legs.get(id);
    if (leg && !leg.gone) leg.session.onLegGone(leg);
  };
  ari.on('StasisEnd', onGone);
  ari.on('ChannelDestroyed', onGone);
  // Legs that never answer never enter Stasis, so watch them explicitly.
  ari.on('ChannelHangupRequest', onGone);

  ari.on('ChannelDtmfReceived', (ev: any) => {
    sessionsByCaller.get(ev.channel?.id)?.onDtmf(ev.digit);
  });
  ari.on('PlaybackFinished', (ev: any) => {
    const w = playbackWaiters.get(ev.playback?.id);
    if (w) w();
  });
  const onRec = (ev: any) => {
    const w = recordingWaiters.get(ev.recording?.name);
    if (w) w(ev);
  };
  ari.on('RecordingFinished', onRec);
  ari.on('RecordingFailed', onRec);

  ari.on('disconnected', () => {
    // Asterisk restarted: in-flight calls are gone.
    for (const s of [...sessionsByCaller.values()]) s.onCallerGone('asterisk restart');
    legs.clear();
  });
}

export function activeCalls() {
  return [...sessionsById.values()].map((s) => ({
    id: s.id,
    tenant_id: s.tenant.id,
    direction: s.direction,
    status: s.status,
    connected: s.connected,
  }));
}
