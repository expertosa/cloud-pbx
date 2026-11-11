import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { AUDIOSOCKET, AudioSocketParser, bytesToUuid, encodeFrame, encodeUuidFrame, startAudioSocketEcho } from '../src/engine/audiosocket.js';

const callId = '22222222-2222-4222-8222-222222222222';

describe('AudioSocket framing', () => {
  it('round-trips a uuid and survives a split packet', () => {
    const frame = encodeUuidFrame(callId);
    expect(frame[0]).toBe(AUDIOSOCKET.UUID);
    expect(frame.readUInt16BE(1)).toBe(16);
    const parser = new AudioSocketParser();
    expect(parser.push(frame.subarray(0, 5))).toEqual([]);
    const frames = parser.push(frame.subarray(5));
    expect(frames).toHaveLength(1);
    expect(bytesToUuid(frames[0]!.payload)).toBe(callId);
  });

  it('echoes audio and records the call id', async () => {
    const echo = await startAudioSocketEcho(0);
    try {
      const audio = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
      const payload = Buffer.concat([encodeUuidFrame(callId), encodeFrame(AUDIOSOCKET.AUDIO, audio)]);
      const received = await new Promise<Buffer>((resolve, reject) => {
        const socket = net.connect(echo.port, '127.0.0.1', () => socket.write(payload));
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (err?: Error, buf?: Buffer) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (err) reject(err);
          else resolve(buf!);
        };
        socket.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
          const frames = new AudioSocketParser().push(Buffer.concat(chunks));
          if (frames.some((f) => f.type === AUDIOSOCKET.AUDIO)) finish(undefined, Buffer.concat(chunks));
        });
        socket.setTimeout(2000, () => finish(new Error('echo timed out')));
        socket.on('error', (err) => {
          if (!settled) finish(err);
        });
      });
      const frames = new AudioSocketParser().push(received);
      const back = frames.find((f) => f.type === AUDIOSOCKET.AUDIO);
      expect(back?.payload.equals(audio)).toBe(true);
      expect(echo.calls).toEqual([callId]);
    } finally {
      await echo.close();
    }
  });
});
