import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { requireTenantAdmin, requireTenantUser } from '../lib/auth.js';
import { HttpError } from '../lib/tenancy.js';

const run = promisify(execFile);
const idParam = z.object({ id: z.uuid() });

/** Convert any uploaded audio to 8 kHz mono 16-bit WAV, the format Asterisk plays without transcoding. */
async function toTelephonyWav(input: string, output: string): Promise<number> {
  try {
    await run('sox', [input, '-r', '8000', '-c', '1', '-b', '16', '-e', 'signed-integer', output, 'norm', '-3'], { timeout: 60_000 });
  } catch {
    // sox lacks mp3/m4a support on some builds; fall back to ffmpeg when present.
    await run('ffmpeg', ['-y', '-i', input, '-ar', '8000', '-ac', '1', '-sample_fmt', 's16', output], { timeout: 60_000 });
  }
  const { stdout } = await run('soxi', ['-D', output]).catch(() => ({ stdout: '0' }));
  return Number(stdout.trim()) || 0;
}

async function sendWav(reply: FastifyReply, filePath: string, downloadName: string) {
  const file = filePath.endsWith('.wav') ? filePath : `${filePath}.wav`;
  // Defence in depth: only serve files from the known media directories.
  const resolved = path.resolve(file);
  if (![config.soundsDir, config.recordingsDir].some((d) => resolved.startsWith(path.resolve(d) + path.sep)))
    throw new HttpError(404, 'الملف غير موجود');
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat) throw new HttpError(404, 'الملف غير موجود');
  reply.header('Content-Type', 'audio/wav');
  reply.header('Content-Length', stat.size);
  reply.header('Cache-Control', 'private, max-age=3600');
  reply.header('Content-Disposition', `inline; filename="${downloadName}.wav"`);
  return reply.send(fs.createReadStream(resolved));
}

export default async function mediaRoutes(app: FastifyInstance) {
  app.get('/api/audio', { preHandler: requireTenantUser }, async (req) =>
    q('select id, name, duration_s, created_at from audio_files where tenant_id=$1 order by created_at desc', [req.user.tid]),
  );

  app.post('/api/audio', { preHandler: requireTenantAdmin }, async (req) => {
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, 'أرفق ملف صوتي');
    const name = (file.fields.name as any)?.value?.toString().trim() || file.filename || 'تسجيل';
    const id = crypto.randomUUID();
    const dir = path.join(config.soundsDir, req.user.tid!);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.upload${path.extname(file.filename || '').slice(0, 6)}`);
    await pipeline(file.file, fs.createWriteStream(tmp));
    if (file.file.truncated) {
      await fsp.rm(tmp, { force: true });
      throw new HttpError(413, 'الملف أكبر من 15 ميجا');
    }
    const base = path.join(dir, id);
    let duration = 0;
    try {
      duration = await toTelephonyWav(tmp, `${base}.wav`);
    } catch {
      throw new HttpError(400, 'تعذّر قراءة الملف الصوتي، جرّب WAV أو MP3');
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    await fsp.chmod(`${base}.wav`, 0o644).catch(() => {});
    return one('insert into audio_files(id, tenant_id, name, path, duration_s) values ($1,$2,$3,$4,$5) returning id, name, duration_s, created_at', [
      id,
      req.user.tid,
      name.slice(0, 120),
      base,
      duration,
    ]);
  });

  app.get('/api/audio/:id/file', { preHandler: requireTenantUser }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const a = await one('select path, name from audio_files where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!a) throw new HttpError(404, 'الملف غير موجود');
    return sendWav(reply, a.path, 'audio');
  });

  app.delete('/api/audio/:id', { preHandler: requireTenantAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const a = await one('delete from audio_files where id=$1 and tenant_id=$2 returning path', [id, req.user.tid]);
    if (a) await fsp.rm(`${a.path}.wav`, { force: true });
    return { ok: true };
  });

  app.get('/api/calls/:id/recording', { preHandler: requireTenantUser }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const c = await one('select recording_path from calls where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!c?.recording_path) throw new HttpError(404, 'لا يوجد تسجيل لهذه المكالمة');
    return sendWav(reply, path.join(config.recordingsDir, c.recording_path), `call-${id}`);
  });

  app.get('/api/voicemails/:id/audio', { preHandler: requireTenantUser }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const v = await one('select path from voicemails where id=$1 and tenant_id=$2', [id, req.user.tid]);
    if (!v) throw new HttpError(404, 'الرسالة غير موجودة');
    return sendWav(reply, path.join(config.recordingsDir, v.path), `voicemail-${id}`);
  });
}
