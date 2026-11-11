import { startAudioSocketEcho } from '../src/engine/audiosocket.js';

/**
 * Local AudioSocket echo peer for the test trunk.
 *
 *   cd server && npx tsx scripts/audiosocket-echo.ts 9092
 *
 * Then place a call with AI_RECEPTIONIST_ENABLED=true and
 * AI_RECEPTIONIST_MEDIA_HOST=127.0.0.1. Asterisk connects here, sends the
 * call id, and you should hear yourself. Ctrl-C to stop.
 */
const port = Number(process.argv[2] ?? process.env.AI_RECEPTIONIST_MEDIA_PORT ?? 9092);
const echo = await startAudioSocketEcho(port);
console.log(`AudioSocket echo on 127.0.0.1:${echo.port} (slin 8 kHz, 16-bit mono)`);
setInterval(() => {
  if (echo.calls.length) console.log(`calls: ${echo.calls.join(', ')}`);
}, 2000);
const stop = () => {
  void echo.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
