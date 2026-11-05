import { describe, it, expect } from 'vitest';
import {
  LABEL_MANIFEST,
  MANIFEST_SCHEMA_VERSION,
  manifestFromLabels,
  manifestToLabel,
  parseManifest,
  type ContainerManifest,
} from '../../src/container/manifest.js';
import { ContainerError } from '../../src/container/types.js';

function valid(overrides: Partial<ContainerManifest> = {}): ContainerManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    name: 'my-agent',
    version: '1.0.0',
    runtime: 'node',
    entrypoint: ['node', 'index.js'],
    volumes: ['/data', '/memory'],
    env: ['MODEL', 'WORKSPACE'],
    secrets: ['anthropic'],
    healthcheck: { test: ['CMD', 'node', '-e', 'process.exit(0)'], intervalSec: 30 },
    isolation: { network: 'proxy', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'generic', contentHash: 'a'.repeat(64) },
    ...overrides,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ContainerError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('parseManifest', () => {
  it('round-trips through the image label', () => {
    const m = valid();
    expect(manifestFromLabels({ [LABEL_MANIFEST]: manifestToLabel(m) })).toEqual(m);
  });

  it('returns null for an image that is not ours', () => {
    expect(manifestFromLabels({})).toBeNull();
  });

  it('rejects non-JSON text', () => {
    expect(code(() => parseManifest('{not json'))).toBe('INVALID_INPUT');
  });

  it('names an unsupported schemaVersion instead of dumping zod noise', () => {
    try {
      parseManifest({ ...valid(), schemaVersion: 2 });
      expect.unreachable();
    } catch (e) {
      expect((e as ContainerError).message).toMatch(/schemaVersion 2/);
      expect((e as ContainerError).message).toMatch(/upgrade AgentVault/);
    }
  });

  it('refuses a root user (uid 0)', () => {
    expect(code(() => parseManifest(valid({ isolation: { network: 'none', user: '0:0', readOnlyRootfs: true } })))).toBe(
      'POLICY_VIOLATION'
    );
    expect(code(() => parseManifest(valid({ isolation: { network: 'none', user: '0:10001', readOnlyRootfs: true } })))).toBe(
      'POLICY_VIOLATION'
    );
  });

  it('rejects unknown keys (typos must not silently pass)', () => {
    expect(code(() => parseManifest({ ...valid(), entrypoints: ['x'] }))).toBe('INVALID_INPUT');
  });

  it('env and secrets are NAMES only: values and bad names are rejected', () => {
    expect(code(() => parseManifest(valid({ env: ['API_KEY=sk-live-123'] })))).toBe('INVALID_INPUT');
    expect(code(() => parseManifest(valid({ secrets: ['../etc'] })))).toBe('INVALID_INPUT');
  });

  it('volumes must be normalized absolute container paths', () => {
    for (const bad of ['data', '/', '/data/', '/data/../x', '/a:b', '/a,b']) {
      expect(code(() => parseManifest(valid({ volumes: [bad] })))).toBe('INVALID_INPUT');
    }
  });

  it('entrypoint is exec-form argv with no empty executable', () => {
    expect(code(() => parseManifest(valid({ entrypoint: [] })))).toBe('INVALID_INPUT');
    expect(code(() => parseManifest(valid({ entrypoint: [''] })))).toBe('INVALID_INPUT');
  });

  it('requires a 64-hex source content hash', () => {
    expect(code(() => parseManifest(valid({ source: { type: 'generic', contentHash: 'abc' } })))).toBe('INVALID_INPUT');
  });

  it('error messages locate the failing field', () => {
    try {
      parseManifest(valid({ name: 'Bad Name' }));
      expect.unreachable();
    } catch (e) {
      expect((e as ContainerError).message).toMatch(/at name/);
    }
  });
});
