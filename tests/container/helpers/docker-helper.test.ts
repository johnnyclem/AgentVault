import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dockerTestEnv } from './docker.js';

const d = dockerTestEnv('avt-helper-');

describe('dockerTestEnv naming', () => {
  it('produces unique, prefixed, docker-safe names', () => {
    const a = d.name('x');
    const b = d.name('x');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^avt-helper-x-[0-9a-f]{6}$/);
  });

  it('produces valid agent names', () => {
    expect(d.agent('web')).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
  });
});

describe.skipIf(!d.available)('dockerTestEnv cleanup (real daemon)', () => {
  afterAll(() => d.cleanup());

  it('removes volumes and networks it owns, and leaves others alone', () => {
    const owned = d.name('vol');
    const foreign = `avt-helper-not-ours-${Date.now()}`.replace('avt-helper-', 'zzz-');
    spawnSync('docker', ['volume', 'create', owned]);
    spawnSync('docker', ['volume', 'create', foreign]);
    try {
      d.cleanup();
      const ls = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout;
      expect(ls).not.toContain(owned);
      expect(ls).toContain(foreign);
    } finally {
      spawnSync('docker', ['volume', 'rm', '-f', foreign]);
    }
  });

  it('tracks agent-derived resources (av-<agent>, av-<agent>-net, av-<agent>-<key>)', () => {
    const agent = d.agent('ag');
    spawnSync('docker', ['volume', 'create', `av-${agent}-data`]);
    spawnSync('docker', ['network', 'create', `av-${agent}-net`]);
    d.cleanup();
    const vols = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout;
    const nets = spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout;
    expect(vols).not.toContain(`av-${agent}-data`);
    expect(nets).not.toContain(`av-${agent}-net`);
  });
});
