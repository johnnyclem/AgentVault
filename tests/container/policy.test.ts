/**
 * Unit tests for src/container/policy.ts. The properties that matter most are
 * negative ones: what the agent must NOT receive. Every spec built here is
 * also pushed through buildRunArgs() to prove policy and docker.ts agree.
 */

import { describe, expect, it } from 'vitest';
import { buildRunArgs } from '../../src/container/docker.js';
import { containerManifestSchema } from '../../src/container/manifest.js';
import type { ContainerManifest } from '../../src/container/manifest.js';
import {
  AGENT_ENV_DENYLIST,
  buildAgentSpec,
  buildProxySpec,
  isDeniedAgentEnvName,
} from '../../src/container/policy.js';
import type { BuildAgentSpecInput } from '../../src/container/policy.js';
import {
  ContainerError,
  DEFAULT_LIMITS,
  PROXY_ALIAS,
  PROXY_CONFIG_ENV,
  PROXY_PLACEHOLDER_KEY,
} from '../../src/container/types.js';
import type { ContainerErrorCode, ProxyPlan } from '../../src/container/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function manifest(over: Partial<ContainerManifest> = {}): ContainerManifest {
  return containerManifestSchema.parse({
    schemaVersion: 1,
    name: 'demo',
    version: '1.0.0',
    runtime: 'node',
    entrypoint: ['node', 'index.js'],
    volumes: ['/data'],
    env: ['ANTHROPIC_API_KEY', 'LOG_LEVEL'],
    secrets: ['anthropic'],
    isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: true },
    source: { type: 'node', contentHash: 'a'.repeat(64) },
    ...over,
  });
}

function agentInput(over: Partial<BuildAgentSpecInput> = {}): BuildAgentSpecInput {
  return {
    agent: 'demo',
    image: 'agentvault/demo:1.0.0',
    manifest: manifest(),
    network: 'none',
    hostEnv: {},
    explicitEnv: {},
    detach: true,
    ...over,
  };
}

const REAL_KEY = 'sk-ant-api03-this-is-the-real-host-secret-0123456789';

function plan(over: Partial<ProxyPlan> = {}): ProxyPlan {
  return {
    config: {
      version: 1,
      listenPort: 8080,
      routes: [
        {
          name: 'anthropic',
          pathPrefix: '/anthropic',
          upstream: 'https://api.anthropic.com',
          inject: [{ header: 'x-api-key', secret: 'anthropic' }],
        },
      ],
      maxBodyBytes: 10_000_000,
      upstreamTimeoutMs: 60_000,
    },
    secrets: { anthropic: REAL_KEY },
    agentEnv: { ANTHROPIC_BASE_URL: `http://${PROXY_ALIAS}:8080/anthropic`, ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY },
    scriptSource: 'import http from "node:http"; http.createServer((_req, res) => res.end("ok")).listen(8080);',
    image: 'node:22-slim',
    ...over,
  };
}

function thrown(fn: () => unknown): ContainerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerError);
    return error as ContainerError;
  }
  throw new Error('expected the call to throw');
}

function expectThrown(fn: () => unknown, code: ContainerErrorCode, message?: RegExp): ContainerError {
  const error = thrown(fn);
  expect(error.code).toBe(code);
  if (message) expect(error.message).toMatch(message);
  return error;
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

describe('isDeniedAgentEnvName', () => {
  it.each([
    'AGENTVAULT_MNEMONIC',
    'AGENTVAULT_PRIVATE_KEY',
    'AGENTVAULT_PASSWORD',
    'AGENTVAULT_SNAPSHOT_PASSPHRASE',
    'AGENTVAULT_',
    'AV_SECRET_ANTHROPIC',
    'AV_SECRET_',
    'AV_PROXY_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'SSH_AUTH_SOCK',
  ])('denies %s', (name) => {
    expect(isDeniedAgentEnvName(name)).toBe(true);
  });

  it.each(['agentvault_mnemonic', 'Av_Secret_Anthropic', 'docker_host', 'ssh_auth_sock'])('denies the case variant %s', (name) => {
    expect(isDeniedAgentEnvName(name)).toBe(true);
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'LOG_LEVEL',
    'PATH',
    'HOME',
    'AGENT_NAME',
    'AV_OTHER',
    'AVAULT_X',
    'XAGENTVAULT_Y',
    'DOCKER_BUILDKIT_X',
    'MY_DOCKER_HOST',
    'SSH_AUTH_SOCKET_PATH_X',
  ])('allows %s', (name) => {
    expect(isDeniedAgentEnvName(name)).toBe(false);
  });

  it('exposes the denylist data', () => {
    expect(AGENT_ENV_DENYLIST.prefixes).toEqual(['AGENTVAULT_', 'AV_SECRET_', 'AV_PROXY_']);
    expect(AGENT_ENV_DENYLIST.names).toEqual(['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK']);
  });
});

// ---------------------------------------------------------------------------
// buildAgentSpec: shape
// ---------------------------------------------------------------------------

describe('buildAgentSpec', () => {
  it('builds the full locked-down spec from a manifest', () => {
    const spec = buildAgentSpec(agentInput({ hostEnv: { LOG_LEVEL: 'debug' } }));
    expect(spec).toEqual({
      name: 'av-demo',
      image: 'agentvault/demo:1.0.0',
      role: 'agent',
      user: '10001:10001',
      network: 'none',
      mounts: [{ kind: 'volume', source: 'av-demo-data', target: '/data' }],
      tmpfs: ['/tmp', '/home/agent'],
      env: { LOG_LEVEL: 'debug' },
      labels: { 'agentvault.managed': 'true', 'agentvault.agent': 'demo', 'agentvault.role': 'agent' },
      limits: { cpus: 2, memory: '2g', pidsLimit: 512 },
      readOnlyRootfs: true,
      detach: true,
      init: true,
      restart: 'no',
    });
  });

  it('passes buildRunArgs and yields the expected isolation flags', () => {
    const spec = buildAgentSpec(agentInput({ hostEnv: { LOG_LEVEL: 'debug' } }));
    const args = buildRunArgs(spec, '/tmp/avt-env-1/env');
    expect(args).toEqual(
      expect.arrayContaining([
        '--name=av-demo',
        '--user=10001:10001',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--network=none',
        '--read-only',
        '--init',
        '--mount=type=volume,source=av-demo-data,target=/data',
        '--label=agentvault.role=agent',
      ])
    );
  });

  it('takes the user from the manifest', () => {
    const spec = buildAgentSpec(agentInput({ manifest: manifest({ isolation: { network: 'none', user: '20000:20001', readOnlyRootfs: true } }) }));
    expect(spec.user).toBe('20000:20001');
  });

  it.each([
    ['uid 0', '0:0'],
    ['uid 0 with a non-zero gid', '0:10001'],
    ['gid 0', '10001:0'],
  ])('rejects a manifest user with %s', (_label, user) => {
    const m = { ...manifest(), isolation: { network: 'none' as const, user, readOnlyRootfs: true } };
    expectThrown(() => buildAgentSpec(agentInput({ manifest: m })), 'POLICY_VIOLATION', /non-zero/);
  });

  it('rejects a malformed manifest user', () => {
    const m = { ...manifest(), isolation: { network: 'none' as const, user: 'root', readOnlyRootfs: true } };
    expectThrown(() => buildAgentSpec(agentInput({ manifest: m })), 'INVALID_INPUT', /numeric/);
  });

  it.each([
    ['bad agent name', { agent: 'Bad Agent' }, /agent name/],
    ['agent name that is a flag', { agent: '--privileged' }, /agent name/],
    ['image that is a flag', { image: '--privileged' }, /image reference/],
  ] as Array<[string, Partial<BuildAgentSpecInput>, RegExp]>)('rejects %s', (_label, over, message) => {
    expectThrown(() => buildAgentSpec(agentInput(over)), 'INVALID_INPUT', message);
  });

  it('passes command, interactive and detach through; omits command when not given', () => {
    const withCommand = buildAgentSpec(agentInput({ command: ['node', '--inspect', 'x.js'], interactive: true, detach: false }));
    expect(withCommand.command).toEqual(['node', '--inspect', 'x.js']);
    expect(withCommand.interactive).toBe(true);
    expect(withCommand.detach).toBe(false);
    const without = buildAgentSpec(agentInput());
    expect('command' in without).toBe(false);
    expect('interactive' in without).toBe(false);
  });

  it('always sets init and defaults restart to no', () => {
    expect(buildAgentSpec(agentInput()).init).toBe(true);
    expect(buildAgentSpec(agentInput()).restart).toBe('no');
    expect(buildAgentSpec(agentInput({ restart: 'unless-stopped' })).restart).toBe('unless-stopped');
  });

  it('never grants capabilities or root', () => {
    const spec = buildAgentSpec(agentInput({ writableRootfs: true, extraMounts: [{ kind: 'bind', source: '/srv/in', target: '/in', readOnly: true }] }));
    expect(spec.capAdd).toBeUndefined();
    expect(spec.allowRoot).toBeUndefined();
    expect(spec.role).toBe('agent');
  });
});

describe('buildAgentSpec: network', () => {
  it.each([
    ['none', 'none'],
    ['bridge', 'bridge'],
    ['proxy', 'av-demo-net'],
  ] as const)('maps %s to %s', (mode, expected) => {
    expect(buildAgentSpec(agentInput({ network: mode })).network).toBe(expected);
  });

  it('rejects an unknown network mode', () => {
    expectThrown(() => buildAgentSpec(agentInput({ network: 'host' as never })), 'INVALID_INPUT', /network mode/);
  });
});

describe('buildAgentSpec: limits', () => {
  it('uses the defaults', () => {
    expect(buildAgentSpec(agentInput()).limits).toEqual(DEFAULT_LIMITS);
  });

  it('overrides only what is given', () => {
    expect(buildAgentSpec(agentInput({ limits: { memory: '512m' } })).limits).toEqual({ cpus: 2, memory: '512m', pidsLimit: 512 });
    expect(buildAgentSpec(agentInput({ limits: { cpus: 0.5, pidsLimit: 64 } })).limits).toEqual({ cpus: 0.5, memory: '2g', pidsLimit: 64 });
  });

  it('does not let an explicit undefined erase a default', () => {
    const spec = buildAgentSpec(agentInput({ limits: { cpus: undefined, memory: undefined, pidsLimit: undefined } }));
    expect(spec.limits).toEqual(DEFAULT_LIMITS);
    expect(() => buildRunArgs(spec)).not.toThrow();
  });

  it('does not mutate the shared defaults', () => {
    buildAgentSpec(agentInput({ limits: { memory: '64m' } }));
    expect(DEFAULT_LIMITS).toEqual({ cpus: 2, memory: '2g', pidsLimit: 512 });
  });
});

describe('buildAgentSpec: mounts and tmpfs', () => {
  it('names a volume per manifest path with resourceNames', () => {
    const spec = buildAgentSpec(agentInput({ manifest: manifest({ volumes: ['/data', '/workspace/state'] }) }));
    expect(spec.mounts).toEqual([
      { kind: 'volume', source: 'av-demo-data', target: '/data' },
      { kind: 'volume', source: 'av-demo-workspace-state', target: '/workspace/state' },
    ]);
  });

  it('has no mounts for a manifest without volumes', () => {
    expect(buildAgentSpec(agentInput({ manifest: manifest({ volumes: [] }) })).mounts).toEqual([]);
  });

  it('appends extra mounts after the manifest volumes', () => {
    const spec = buildAgentSpec(agentInput({ extraMounts: [{ kind: 'bind', source: '/srv/in', target: '/inputs', readOnly: true }] }));
    expect(spec.mounts.map((m) => m.target)).toEqual(['/data', '/inputs']);
    expect(spec.mounts[1]).toEqual({ kind: 'bind', source: '/srv/in', target: '/inputs', readOnly: true });
  });

  it('rejects a volume key collision between two manifest paths', () => {
    expectThrown(() => buildAgentSpec(agentInput({ manifest: manifest({ volumes: ['/a/b', '/a-b'] }) })), 'INVALID_INPUT', /both map to volume key/);
  });

  it('rejects an extra mount on a manifest volume target', () => {
    expectThrown(
      () => buildAgentSpec(agentInput({ extraMounts: [{ kind: 'bind', source: '/srv/x', target: '/data' }] })),
      'INVALID_INPUT',
      /more than once/
    );
  });

  it('rejects two extra mounts on one target', () => {
    expectThrown(
      () =>
        buildAgentSpec(
          agentInput({
            extraMounts: [
              { kind: 'bind', source: '/srv/x', target: '/in' },
              { kind: 'volume', source: 'other', target: '/in' },
            ],
          })
        ),
      'INVALID_INPUT',
      /more than once/
    );
  });

  it('gives /tmp and /home/agent a tmpfs by default', () => {
    expect(buildAgentSpec(agentInput()).tmpfs).toEqual(['/tmp', '/home/agent']);
  });

  it.each([
    ['a volume at /tmp', [{ kind: 'volume', source: 'scratch', target: '/tmp' }], ['/home/agent']],
    ['a volume at /home/agent', [{ kind: 'volume', source: 'home', target: '/home/agent' }], ['/tmp']],
    ['a mount at /home (covers /home/agent)', [{ kind: 'volume', source: 'home', target: '/home' }], ['/tmp']],
    ['both', [{ kind: 'volume', source: 'a', target: '/tmp' }, { kind: 'volume', source: 'b', target: '/home/agent' }], []],
    ['a mount below /home/agent (does not cover it)', [{ kind: 'volume', source: 'w', target: '/home/agent/work' }], ['/tmp', '/home/agent']],
    ['a mount at /tmpx (not a parent of /tmp)', [{ kind: 'volume', source: 'w', target: '/tmpx' }], ['/tmp', '/home/agent']],
  ] as const)('skips tmpfs already covered by %s', (_label, extra, expected) => {
    const spec = buildAgentSpec(agentInput({ extraMounts: [...extra] }));
    expect(spec.tmpfs).toEqual(expected);
    // Whatever policy produces must never collide with a mount in docker.ts.
    expect(() => buildRunArgs(spec)).not.toThrow();
  });

  it('is read-only by default and writable only on request', () => {
    expect(buildAgentSpec(agentInput()).readOnlyRootfs).toBe(true);
    expect(buildAgentSpec(agentInput({ writableRootfs: false })).readOnlyRootfs).toBe(true);
    expect(buildAgentSpec(agentInput({ writableRootfs: true })).readOnlyRootfs).toBe(false);
  });

  it('ignores a manifest that asks for a writable root (the CLI flag is the only way)', () => {
    const m = manifest({ isolation: { network: 'none', user: '10001:10001', readOnlyRootfs: false } });
    expect(buildAgentSpec(agentInput({ manifest: m })).readOnlyRootfs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAgentSpec: environment
// ---------------------------------------------------------------------------

describe('buildAgentSpec: environment', () => {
  it('takes manifest-declared names from the host', () => {
    const spec = buildAgentSpec(agentInput({ hostEnv: { ANTHROPIC_API_KEY: 'host-key', LOG_LEVEL: 'info' } }));
    expect(spec.env).toEqual({ ANTHROPIC_API_KEY: 'host-key', LOG_LEVEL: 'info' });
  });

  it('forwards NOTHING from the host that the manifest does not declare', () => {
    const hostEnv = {
      LOG_LEVEL: 'info',
      PATH: '/usr/bin',
      HOME: '/root',
      GITHUB_TOKEN: 'ghp_hostsecret',
      AWS_SECRET_ACCESS_KEY: 'aws-hostsecret',
      OPENAI_API_KEY: 'sk-openai-hostsecret',
      AGENTVAULT_MNEMONIC: 'abandon abandon abandon',
    };
    const spec = buildAgentSpec(agentInput({ hostEnv }));
    expect(spec.env).toEqual({ LOG_LEVEL: 'info' });
    const serialized = JSON.stringify(spec);
    for (const secret of ['ghp_hostsecret', 'aws-hostsecret', 'sk-openai-hostsecret', 'abandon abandon abandon']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('skips declared names the host does not have, but keeps an empty string', () => {
    const spec = buildAgentSpec(agentInput({ hostEnv: { ANTHROPIC_API_KEY: undefined, LOG_LEVEL: '' } }));
    expect(spec.env).toEqual({ LOG_LEVEL: '' });
  });

  it('lets explicit env beat the host, and allows explicit names beyond the manifest', () => {
    const spec = buildAgentSpec(
      agentInput({
        hostEnv: { LOG_LEVEL: 'info' },
        explicitEnv: { LOG_LEVEL: 'debug', EXTRA_FLAG: '1' },
      })
    );
    expect(spec.env).toEqual({ LOG_LEVEL: 'debug', EXTRA_FLAG: '1' });
  });

  it('keeps an explicit empty string over the host value', () => {
    const spec = buildAgentSpec(agentInput({ hostEnv: { LOG_LEVEL: 'info' }, explicitEnv: { LOG_LEVEL: '' } }));
    expect(spec.env['LOG_LEVEL']).toBe('');
  });

  it('does not mutate its inputs and returns a fresh env object', () => {
    const hostEnv = { LOG_LEVEL: 'info' };
    const explicitEnv = { X: '1' };
    const proxyAgentEnv = { ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY };
    const spec = buildAgentSpec(agentInput({ hostEnv, explicitEnv, proxyAgentEnv, network: 'proxy' }));
    spec.env['MUTATED'] = 'yes';
    expect(hostEnv).toEqual({ LOG_LEVEL: 'info' });
    expect(explicitEnv).toEqual({ X: '1' });
    expect(proxyAgentEnv).toEqual({ ANTHROPIC_API_KEY: PROXY_PLACEHOLDER_KEY });
  });

  it('rejects an invalid explicit variable name', () => {
    expectThrown(() => buildAgentSpec(agentInput({ explicitEnv: { 'BAD NAME': '1' } })), 'INVALID_INPUT', /environment variable name/);
  });

  describe('reserved names', () => {
    const reserved = ['AGENTVAULT_MNEMONIC', 'AGENTVAULT_PRIVATE_KEY', 'AGENTVAULT_PASSWORD', 'AV_SECRET_ANTHROPIC', 'AV_PROXY_CONFIG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK'];

    it.each(reserved)('rejects %s when passed explicitly, without echoing the value', (name) => {
      const error = expectThrown(
        () => buildAgentSpec(agentInput({ explicitEnv: { [name]: 'super-secret-value-123' } })),
        'POLICY_VIOLATION',
        new RegExp(name)
      );
      expect(error.message).not.toContain('super-secret-value-123');
    });

    it.each(reserved)('rejects %s passed explicitly even when the manifest declares it', (name) => {
      expectThrown(
        () => buildAgentSpec(agentInput({ manifest: manifest({ env: [name] }), explicitEnv: { [name]: 'v' } })),
        'POLICY_VIOLATION'
      );
    });

    it.each(reserved)('silently drops %s from the host even when the manifest declares it', (name) => {
      const spec = buildAgentSpec(agentInput({ manifest: manifest({ env: [name, 'LOG_LEVEL'] }), hostEnv: { [name]: 'host-value', LOG_LEVEL: 'info' } }));
      expect(spec.env).toEqual({ LOG_LEVEL: 'info' });
    });

    it.each(reserved)('does not forward %s from the host when the manifest does not declare it', (name) => {
      expect(buildAgentSpec(agentInput({ hostEnv: { [name]: 'host-value' } })).env).toEqual({});
    });

    it('rejects a lower-case twin of a reserved name', () => {
      expectThrown(() => buildAgentSpec(agentInput({ explicitEnv: { agentvault_mnemonic: 'x' } })), 'POLICY_VIOLATION');
    });

    it('blocks AGENTVAULT_MNEMONIC both ways in one spec', () => {
      expectThrown(
        () => buildAgentSpec(agentInput({ manifest: manifest({ env: ['AGENTVAULT_MNEMONIC'] }), hostEnv: { AGENTVAULT_MNEMONIC: 'word word' }, explicitEnv: { AGENTVAULT_MNEMONIC: 'word word' } })),
        'POLICY_VIOLATION'
      );
      const viaHost = buildAgentSpec(agentInput({ manifest: manifest({ env: ['AGENTVAULT_MNEMONIC'] }), hostEnv: { AGENTVAULT_MNEMONIC: 'word word' } }));
      expect(JSON.stringify(viaHost)).not.toContain('word word');
    });
  });

  describe('proxy mode', () => {
    it('replaces a real host key with the placeholder', () => {
      const p = plan();
      const spec = buildAgentSpec(
        agentInput({
          network: 'proxy',
          hostEnv: { ANTHROPIC_API_KEY: REAL_KEY, LOG_LEVEL: 'info' },
          proxyAgentEnv: p.agentEnv,
        })
      );
      expect(spec.env['ANTHROPIC_API_KEY']).toBe(PROXY_PLACEHOLDER_KEY);
      expect(spec.env['ANTHROPIC_BASE_URL']).toBe(`http://${PROXY_ALIAS}:8080/anthropic`);
      expect(spec.env['LOG_LEVEL']).toBe('info');
      expect(JSON.stringify(spec)).not.toContain(REAL_KEY);
    });

    it('replaces a real key typed on the command line too', () => {
      const spec = buildAgentSpec(
        agentInput({ network: 'proxy', explicitEnv: { ANTHROPIC_API_KEY: REAL_KEY }, proxyAgentEnv: plan().agentEnv })
      );
      expect(spec.env['ANTHROPIC_API_KEY']).toBe(PROXY_PLACEHOLDER_KEY);
      expect(JSON.stringify(spec)).not.toContain(REAL_KEY);
    });

    it('keeps the real key when there is no proxy (the user chose bridge or none)', () => {
      const spec = buildAgentSpec(agentInput({ network: 'bridge', hostEnv: { ANTHROPIC_API_KEY: REAL_KEY }, proxyAgentEnv: plan().agentEnv }));
      expect(spec.env['ANTHROPIC_API_KEY']).toBe(REAL_KEY);
      expect(spec.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    });

    it('refuses a plan whose agent env carries a reserved name', () => {
      expectThrown(
        () => buildAgentSpec(agentInput({ network: 'proxy', proxyAgentEnv: { AV_SECRET_ANTHROPIC: REAL_KEY } })),
        'POLICY_VIOLATION',
        /AV_SECRET_ANTHROPIC/
      );
    });

    it('produces a spec that passes buildRunArgs on the internal network', () => {
      const spec = buildAgentSpec(agentInput({ network: 'proxy', proxyAgentEnv: plan().agentEnv }));
      const args = buildRunArgs(spec, '/tmp/avt-env-1/env');
      expect(args).toContain('--network=av-demo-net');
      expect(args).toContain('--env-file=/tmp/avt-env-1/env');
      expect(args.join('\n')).not.toContain(PROXY_PLACEHOLDER_KEY);
    });
  });
});

// ---------------------------------------------------------------------------
// buildProxySpec
// ---------------------------------------------------------------------------

describe('buildProxySpec', () => {
  it('builds the sidecar spec', () => {
    const p = plan();
    const spec = buildProxySpec({ agent: 'demo', plan: p });
    expect(spec).toEqual({
      name: 'av-demo-proxy',
      image: 'node:22-slim',
      role: 'proxy',
      command: ['node', '--input-type=module', '-e', p.scriptSource],
      user: '1000:1000',
      network: 'av-demo-net',
      networkAliases: ['agentvault-proxy'],
      mounts: [],
      tmpfs: ['/tmp'],
      env: {
        [PROXY_CONFIG_ENV]: JSON.stringify(p.config),
        AV_SECRET_ANTHROPIC: REAL_KEY,
      },
      labels: { 'agentvault.managed': 'true', 'agentvault.agent': 'demo', 'agentvault.role': 'proxy' },
      limits: { cpus: 1, memory: '256m', pidsLimit: 128 },
      readOnlyRootfs: true,
      detach: true,
      init: true,
      restart: 'no',
    });
  });

  it('maps every secret to its AV_SECRET_ variable (dashes become underscores)', () => {
    const spec = buildProxySpec({ agent: 'demo', plan: plan({ secrets: { anthropic: 'a'.repeat(20), 'my-key': 'b'.repeat(20) } }) });
    expect(spec.env['AV_SECRET_ANTHROPIC']).toBe('a'.repeat(20));
    expect(spec.env['AV_SECRET_MY_KEY']).toBe('b'.repeat(20));
    expect(Object.keys(spec.env).sort()).toEqual(['AV_PROXY_CONFIG', 'AV_SECRET_ANTHROPIC', 'AV_SECRET_MY_KEY']);
  });

  it('runs non-root with no extra capabilities and a read-only root', () => {
    const spec = buildProxySpec({ agent: 'demo', plan: plan() });
    expect(spec.user).toBe('1000:1000');
    expect(spec.readOnlyRootfs).toBe(true);
    expect(spec.capAdd).toBeUndefined();
    expect(spec.allowRoot).toBeUndefined();
  });

  it('passes buildRunArgs with the proxy alias on the internal network', () => {
    const args = buildRunArgs(buildProxySpec({ agent: 'demo', plan: plan() }), '/tmp/avt-env-1/env');
    expect(args).toEqual(
      expect.arrayContaining(['--network=av-demo-net', '--network-alias=agentvault-proxy', '--user=1000:1000', '--read-only', '--cap-drop=ALL', '--memory=256m', '--cpus=1', '--pids-limit=128'])
    );
  });

  describe('secrets live only in the environment', () => {
    it('keeps secret values out of the command, the labels and every other field', () => {
      const spec = buildProxySpec({ agent: 'demo', plan: plan() });
      const { env, ...everythingElse } = spec;
      expect(JSON.stringify(everythingElse)).not.toContain(REAL_KEY);
      expect(spec.command?.join(' ')).not.toContain(REAL_KEY);
      expect(env['AV_SECRET_ANTHROPIC']).toBe(REAL_KEY);
      expect(env[PROXY_CONFIG_ENV]).not.toContain(REAL_KEY);
    });

    it('keeps secret values off the docker argv', () => {
      const args = buildRunArgs(buildProxySpec({ agent: 'demo', plan: plan() }), '/tmp/avt-env-1/env');
      for (const element of args) expect(element).not.toContain(REAL_KEY);
    });

    it('refuses a plan that embeds a secret value in the script', () => {
      const bad = plan({ scriptSource: `const KEY = "${REAL_KEY}";` });
      expectThrown(() => buildProxySpec({ agent: 'demo', plan: bad }), 'POLICY_VIOLATION', /embeds a secret value/);
    });

    it('refuses a plan that embeds a secret value in the config', () => {
      const p = plan();
      const bad = plan({ config: { ...p.config, routes: [{ ...p.config.routes[0]!, upstream: `https://x.example/${REAL_KEY}` }] } });
      expectThrown(() => buildProxySpec({ agent: 'demo', plan: bad }), 'POLICY_VIOLATION', /embeds a secret value/);
    });

    it('does not mistake a short secret for an embedded one', () => {
      const p = plan({ secrets: { anthropic: 'key' }, scriptSource: 'const key = "key"; // header name' });
      expect(buildProxySpec({ agent: 'demo', plan: p }).env['AV_SECRET_ANTHROPIC']).toBe('key');
    });
  });

  it('adds hosts from the plan, and omits the field when there are none', () => {
    const withHosts = buildProxySpec({ agent: 'demo', plan: plan({ addHosts: ['host.docker.internal:host-gateway'] }) });
    expect(withHosts.addHosts).toEqual(['host.docker.internal:host-gateway']);
    expect(buildRunArgs(withHosts, '/tmp/avt-env-1/env')).toContain('--add-host=host.docker.internal:host-gateway');
    expect('addHosts' in buildProxySpec({ agent: 'demo', plan: plan() })).toBe(false);
    expect('addHosts' in buildProxySpec({ agent: 'demo', plan: plan({ addHosts: [] }) })).toBe(false);
  });

  it('copies addHosts rather than aliasing the plan array', () => {
    const hosts = ['a.local:10.0.0.1'];
    const spec = buildProxySpec({ agent: 'demo', plan: plan({ addHosts: hosts }) });
    spec.addHosts?.push('b.local:10.0.0.2');
    expect(hosts).toEqual(['a.local:10.0.0.1']);
  });

  it('can be told which internal network to join', () => {
    expect(buildProxySpec({ agent: 'demo', plan: plan(), internalNetwork: 'custom-net' }).network).toBe('custom-net');
  });

  it('does not mutate the plan', () => {
    const p = plan();
    const before = JSON.stringify(p);
    buildProxySpec({ agent: 'demo', plan: p });
    expect(JSON.stringify(p)).toBe(before);
  });

  it.each([
    ['bad agent name', () => buildProxySpec({ agent: 'Bad Agent', plan: plan() }), /agent name/],
    ['bad secret name', () => buildProxySpec({ agent: 'demo', plan: plan({ secrets: { 'Bad_Name': 'x'.repeat(20) } }) }), /secret name/],
    ['bad image', () => buildProxySpec({ agent: 'demo', plan: plan({ image: '--privileged' }) }), /image reference/],
  ])('rejects %s', (_label, fn, message) => {
    expectThrown(fn, 'INVALID_INPUT', message);
  });

  it('rejects a secret whose value cannot travel in an env file (multi-line) at argv-build time', () => {
    const spec = buildProxySpec({ agent: 'demo', plan: plan({ secrets: { anthropic: 'line1\nline2-line2-line2' } }) });
    expectThrown(() => buildRunArgs(spec, '/tmp/avt-env-1/env'), 'INVALID_INPUT', /AV_SECRET_ANTHROPIC.*cannot carry/);
  });
});
