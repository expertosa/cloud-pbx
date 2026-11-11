import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../asterisk/render-config.sh');

function render(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-ast-'));
  // The renderer also fills the stock templates with envsubst. The test only
  // reads pjsip_trunk.conf, which is written directly, so a cat stub is enough
  // when gettext is not installed.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-bin-'));
  fs.writeFileSync(path.join(bin, 'envsubst'), '#!/bin/sh\ncat\n', { mode: 0o755 });
  execFileSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      AST_ETC_DIR: dir,
      ARI_PASSWORD: 'test-ari',
      TRUNK_MODE: 'none',
      EXTERNAL_IP: '203.0.113.10',
      TEST_TRUNK: '1',
      ...extra,
    },
  });
  return fs.readFileSync(path.join(dir, 'pjsip_trunk.conf'), 'utf8');
}

describe('test trunk rendering', () => {
  it('identifies sim-carrier by its own address, not by the endpoint name', () => {
    const conf = render();
    expect(conf).toContain('identify_by = ip');
    expect(conf).toContain('match = 127.0.0.1:5090');
    expect(conf).toContain('[sim-carrier-identify]');
    expect(conf).not.toMatch(/\[sim-carrier\][\s\S]{0,200}type = auth/);
    const endpoint = conf.split('[sim-carrier-identify]')[0] ?? '';
    expect(endpoint).not.toContain('identify_by = username');
  });

  it('uses TEST_TRUNK_MATCH and drops values that could break the config', () => {
    const conf = render({ TEST_TRUNK_MATCH: '10.8.0.4, 192.168.1.9:5062, evil\nmatch = 0.0.0.0'.replace('\\n', '\n') });
    expect(conf).toContain('match = 10.8.0.4');
    expect(conf).toContain('match = 192.168.1.9:5062');
    expect(conf).not.toContain('evil');
    expect(conf).not.toContain('0.0.0.0');
  });

  it('does not add the open carrier when the test trunk is off', () => {
    const conf = render({ TEST_TRUNK: '0' });
    expect(conf).not.toContain('sim-carrier');
    expect(conf).not.toContain('from-trunk');
  });
});
