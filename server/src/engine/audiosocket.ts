import net from 'node:net';

/**
 * AudioSocket framing used by Asterisk 20.6 res_audiosocket.
 *
 * Each message is: 1 byte type, 2 byte big-endian payload length, payload.
 *   0x00 hangup (empty payload)
 *   0x01 UUID (16 raw bytes) — Asterisk sends this once, right after connect
 *   0x10 signed-linear 16-bit mono audio (8 kHz on the Ubuntu 24.04 build)
 *   0xff error
 *
 * The UUID bytes are the `data` value passed to ARI externalMedia, which we
 * set to the call session id so the receptionist can correlate the socket
 * with POST /api/integrations/calls/:id/transfer.
 */
export const AUDIOSOCKET = {
  HANGUP: 0x00,
  UUID: 0x01,
  AUDIO: 0x10,
  ERROR: 0xff,
  MAX_PAYLOAD: 8192,
} as const;

export interface AudioSocketFrame {
  type: number;
  payload: Buffer;
}

export function encodeFrame(type: number, payload: Buffer): Buffer {
  if (payload.length > AUDIOSOCKET.MAX_PAYLOAD) throw new Error('audiosocket payload too large');
  const out = Buffer.alloc(3 + payload.length);
  out[0] = type;
  out.writeUInt16BE(payload.length, 1);
  payload.copy(out, 3);
  return out;
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('invalid uuid');
  return Buffer.from(hex, 'hex');
}

export function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  if (hex.length !== 32) throw new Error('uuid payload must be 16 bytes');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeUuidFrame(uuid: string): Buffer {
  return encodeFrame(AUDIOSOCKET.UUID, uuidToBytes(uuid));
}

/** Incremental parser: TCP may split or coalesce frames. */
export class AudioSocketParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): AudioSocketFrame[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const frames: AudioSocketFrame[] = [];
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (len > AUDIOSOCKET.MAX_PAYLOAD) throw new Error('audiosocket payload too large');
      if (this.buf.length < 3 + len) break;
      frames.push({ type: this.buf[0]!, payload: Buffer.from(this.buf.subarray(3, 3 + len)) });
      this.buf = Buffer.from(this.buf.subarray(3 + len));
    }
    return frames;
  }
}

export interface EchoServer {
  port: number;
  /** Call ids announced by Asterisk (or the test client) on each connection. */
  calls: string[];
  close: () => Promise<void>;
}

/**
 * Local AudioSocket peer that echoes 0x10 frames back. Used to prove the
 * media path against TEST_TRUNK=1 without a carrier or the real receptionist.
 * Binds to 127.0.0.1 only.
 */
export function startAudioSocketEcho(port = 0): Promise<EchoServer> {
  const calls: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const parser = new AudioSocketParser();
    socket.on('data', (chunk) => {
      let frames: AudioSocketFrame[];
      try {
        frames = parser.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === AUDIOSOCKET.UUID && frame.payload.length === 16) {
          try {
            calls.push(bytesToUuid(frame.payload));
          } catch {
            /* ignore malformed ids */
          }
        } else if (frame.type === AUDIOSOCKET.AUDIO) {
          socket.write(encodeFrame(AUDIOSOCKET.AUDIO, frame.payload));
        } else if (frame.type === AUDIOSOCKET.HANGUP) {
          socket.end(encodeFrame(AUDIOSOCKET.HANGUP, Buffer.alloc(0)));
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: bound,
        calls,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
