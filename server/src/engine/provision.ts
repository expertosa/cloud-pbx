import { q } from '../db.js';
import type { Extension } from '../lib/types.js';
import { logger } from '../lib/logger.js';
import { ari } from './ari.js';

type Fields = Record<string, string>;
const toFields = (f: Fields) => ({ fields: Object.entries(f).map(([attribute, value]) => ({ attribute, value })) });

async function putObject(type: 'endpoint' | 'auth' | 'aor', id: string, fields: Fields) {
  await ari.put(`/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`, undefined, toFields(fields));
}

async function deleteObject(type: 'endpoint' | 'auth' | 'aor', id: string) {
  await ari.quiet(() => ari.del(`/asterisk/config/dynamic/res_pjsip/${type}/${encodeURIComponent(id)}`));
}

/**
 * Every extension gets two SIP accounts:
 *  - web_username: WebRTC (DTLS-SRTP, ICE) used by the browser phone in the dashboard
 *  - sip_username: plain SIP for softphone apps (Zoiper, Linphone) and desk phones
 * Both ring together when the extension is called.
 */
export async function provisionExtension(ext: Extension): Promise<void> {
  const callerid = `"${ext.name.replace(/"/g, '')}" <${ext.number}>`;
  const common: Fields = {
    context: 'from-internal',
    disallow: 'all',
    direct_media: 'no',
    callerid,
    dtmf_mode: 'rfc4733',
    language: 'ar',
    send_pai: 'yes',
    trust_id_inbound: 'no',
  };

  await putObject('auth', ext.web_username, { auth_type: 'userpass', username: ext.web_username, password: ext.web_password });
  await putObject('aor', ext.web_username, { max_contacts: '3', remove_existing: 'yes', remove_unavailable: 'yes', qualify_frequency: '30' });
  await putObject('endpoint', ext.web_username, {
    ...common,
    allow: 'opus,ulaw,alaw',
    auth: ext.web_username,
    aors: ext.web_username,
    webrtc: 'yes',
  });

  await putObject('auth', ext.sip_username, { auth_type: 'userpass', username: ext.sip_username, password: ext.sip_password });
  await putObject('aor', ext.sip_username, { max_contacts: '3', remove_existing: 'yes', qualify_frequency: '60' });
  await putObject('endpoint', ext.sip_username, {
    ...common,
    allow: 'ulaw,alaw,g722,opus',
    auth: ext.sip_username,
    aors: ext.sip_username,
    rtp_symmetric: 'yes',
    force_rport: 'yes',
    rewrite_contact: 'yes',
  });
}

export async function deprovisionExtension(ext: Pick<Extension, 'web_username' | 'sip_username'>): Promise<void> {
  for (const id of [ext.web_username, ext.sip_username]) {
    await deleteObject('endpoint', id);
    await deleteObject('aor', id);
    await deleteObject('auth', id);
  }
}

/** Push every extension to Asterisk (idempotent). Run whenever ARI (re)connects. */
export async function syncAllExtensions(): Promise<void> {
  const exts = await q<Extension>('select * from extensions');
  let ok = 0;
  for (const e of exts) {
    try {
      await provisionExtension(e);
      ok++;
    } catch (err) {
      logger.error({ err: String(err), ext: e.sip_username }, 'failed to provision extension');
    }
  }
  logger.info({ count: ok, total: exts.length }, 'extensions provisioned to Asterisk');
}
