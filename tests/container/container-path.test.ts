/**
 * Volume paths may not cover system locations. A volume mounted at /etc or /proc
 * either breaks the container (runc refuses a mount over /proc) or replaces a
 * directory the image relies on, and a /tmp volume would swap the agent's
 * noexec tmpfs for a persistent exec-capable disk.
 *
 * Kept apart from validate.test.ts, which covers the syntax rules.
 */

import { describe, expect, it } from 'vitest';
import { renderDockerfile } from '../../src/container/dockerfile.js';
import { parseManifest } from '../../src/container/manifest.js';
import { assertContainerPath, isSystemContainerPath } from '../../src/container/validate.js';
import { ContainerError } from '../../src/container/types.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContainerError);
    return (err as ContainerError).code;
  }
  throw new Error('expected a ContainerError');
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected an error');
}

const SYSTEM_TREES = ['/proc', '/sys', '/dev', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/run', '/var/run', '/root'];
const SYSTEM_EXACT = ['/tmp', '/home/agent'];

function manifestWith(volumes: string[]): unknown {
  return {
    schemaVersion: 1,
    name: 'demo',
    version: '1.0.0',
    runtime: 'node',
    entrypoint: ['node', 'index.js'],
    volumes,
    env: [],
    secrets: [],
    isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'generic', contentHash: 'a'.repeat(64) },
  };
}

describe('assertContainerPath and system locations', () => {
  it.each([...SYSTEM_TREES, ...SYSTEM_EXACT])('rejects %s', (p) => {
    expect(codeOf(() => assertContainerPath(p))).toBe('INVALID_INPUT');
    expect(messageOf(() => assertContainerPath(p))).toMatch(/system location/);
  });

  it.each(SYSTEM_TREES.flatMap((tree) => [`${tree}/x`, `${tree}/a/b`]))('rejects %s, below a system tree', (p) => {
    expect(codeOf(() => assertContainerPath(p))).toBe('INVALID_INPUT');
  });

  it.each(['/dev/shm', '/run/secrets', '/proc/self', '/etc/ssh', '/usr/local/bin', '/var/run/docker'])('rejects the nested system path %s', (p) => {
    expect(codeOf(() => assertContainerPath(p))).toBe('INVALID_INPUT');
  });

  it.each([
    '/data', '/memory', '/data/x', '/home/agent/data', '/home/agent/.cache', '/tmp/x', '/tmp/a/b', '/opt/app', '/srv/agent', '/mnt/data',
    '/var/lib/agent', '/var', '/var/log/agent', '/home', '/home/other',
    // Prefix matching is by whole path segment: these only START with a system name.
    '/etcetera', '/usr2/x', '/rootfs', '/runtime', '/devices', '/bin2', '/library', '/procs', '/system', '/var/running', '/boots',
  ])('accepts %s', (p) => {
    expect(assertContainerPath(p)).toBe(p);
    expect(isSystemContainerPath(p)).toBe(false);
  });

  it('can be told to allow system paths, for the fixed tmpfs mounts, but still checks the syntax', () => {
    expect(assertContainerPath('/tmp', { allowSystem: true })).toBe('/tmp');
    expect(assertContainerPath('/home/agent', { allowSystem: true })).toBe('/home/agent');
    expect(codeOf(() => assertContainerPath('tmp', { allowSystem: true }))).toBe('INVALID_INPUT');
    expect(codeOf(() => assertContainerPath('/tmp/../etc', { allowSystem: true }))).toBe('INVALID_INPUT');
  });

  it('does not let a traversal sneak a system path past the check', () => {
    expect(codeOf(() => assertContainerPath('/data/../etc'))).toBe('INVALID_INPUT');
    expect(codeOf(() => assertContainerPath('//etc'))).toBe('INVALID_INPUT');
    expect(codeOf(() => assertContainerPath('/etc/'))).toBe('INVALID_INPUT');
  });
});

describe('a manifest (for example an image label) cannot declare a system volume', () => {
  // Docker normalizes the target, so a spelling the regex allows must not hide a system path.
  it.each(['//etc', '/./etc', '/etc/./ssh', '//tmp', '/home//agent', '/./home/agent'])('rejects the unnormalized spelling %s', (p) => {
    expect(isSystemContainerPath(p)).toBe(true);
    expect(codeOf(() => parseManifest(manifestWith([p])))).toBe('INVALID_INPUT');
  });

  it.each([...SYSTEM_TREES, ...SYSTEM_EXACT, '/dev/shm', '/etc/ssh'])('rejects volumes: [%s]', (p) => {
    expect(codeOf(() => parseManifest(manifestWith(['/data', p])))).toBe('INVALID_INPUT');
    expect(messageOf(() => parseManifest(JSON.stringify(manifestWith([p]))))).toMatch(/volumes\.0.*system location/);
  });

  it('still accepts ordinary volumes', () => {
    expect(parseManifest(manifestWith(['/data', '/home/agent/state', '/memory'])).volumes).toEqual(['/data', '/home/agent/state', '/memory']);
  });

  it('keeps the Dockerfile from chown-ing a system directory', () => {
    expect(() => renderDockerfile({ manifest: manifestWith(['/etc']) as never, base: 'node:22-slim', install: 'none' })).toThrow(ContainerError);
  });
});
