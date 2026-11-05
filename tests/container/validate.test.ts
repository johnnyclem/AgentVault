import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  agentvaultHome,
  assertAgentName,
  assertBindSource,
  assertContainerPath,
  assertEnvName,
  assertImageRef,
  assertSecretName,
  assertVolumeKey,
  parseUser,
  resourceNames,
  secretEnvName,
  volumeKeyForPath,
  volumeKeysForPaths,
} from '../../src/container/validate.js';
import { ContainerError } from '../../src/container/types.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ContainerError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('assertAgentName', () => {
  it('accepts simple names', () => {
    for (const ok of ['a', 'my-agent', 'agent_2', '0abc', 'a'.repeat(40)]) {
      expect(assertAgentName(ok)).toBe(ok);
    }
  });

  it.each([
    '',
    '-x', // would parse as a docker flag
    '_x',
    '.x',
    'Agent', // uppercase is invalid in image names
    'a.b',
    'a/b',
    '../x',
    'a b',
    'a:b',
    'a,b',
    'a=b',
    'a\nb',
    'a'.repeat(41),
  ])('rejects %j', (bad) => {
    expect(code(() => assertAgentName(bad))).toBe('INVALID_INPUT');
  });

  it('rejects non-strings', () => {
    expect(code(() => assertAgentName(undefined as unknown as string))).toBe('INVALID_INPUT');
    expect(code(() => assertAgentName(42 as unknown as string))).toBe('INVALID_INPUT');
  });
});

describe('assertImageRef', () => {
  it('accepts common refs', () => {
    for (const ok of [
      'node:22-slim',
      'agentvault/my-agent:1.0.0',
      'ghcr.io/org/img:tag',
      'registry.example.com:5000/a/b@sha256:' + 'a'.repeat(64),
    ]) {
      expect(assertImageRef(ok)).toBe(ok);
    }
  });

  it.each(['', '-v', '--privileged', '.x', 'a b', 'a\nFROM x', 'a;b', 'a$(x)', 'a`x`', "a'b", 'a'.repeat(256)])(
    'rejects %j',
    (bad) => {
      expect(code(() => assertImageRef(bad))).toBe('INVALID_INPUT');
    }
  );
});

describe('assertContainerPath', () => {
  it('accepts normalized absolute paths', () => {
    for (const ok of ['/data', '/memory', '/home/agent/.cache', '/a/b-c_d.e']) {
      expect(assertContainerPath(ok)).toBe(ok);
    }
  });

  it.each([
    'data',
    './data',
    '/data/',
    '/data/../etc',
    '/data/./x',
    '/da:ta', // ':' splits -v specs
    '/da,ta', // ',' injects extra --mount options
    '/da=ta',
    '/da ta',
    '/da"ta',
    '/da\nta',
    '',
  ])('rejects %j', (bad) => {
    expect(code(() => assertContainerPath(bad))).toBe('INVALID_INPUT');
  });
});

describe('assertBindSource', () => {
  it('accepts an ordinary absolute path and normalizes it', () => {
    expect(assertBindSource('/home/me/work/../work')).toBe(path.resolve('/home/me/work'));
  });

  it('rejects relative paths and metacharacters', () => {
    expect(code(() => assertBindSource('work'))).toBe('INVALID_INPUT');
    expect(code(() => assertBindSource('/a,readonly=false'))).toBe('INVALID_INPUT');
    expect(code(() => assertBindSource('/a\0b'))).toBe('INVALID_INPUT');
  });

  describe('symlinks and sockets', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-bind-'));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('resolves a symlink with an innocent name that points at docker.sock', () => {
      const target = path.join(dir, 'docker.sock');
      fs.writeFileSync(target, '');
      const link = path.join(dir, 'innocent-looking');
      fs.symlinkSync(target, link);
      expect(code(() => assertBindSource(link))).toBe('POLICY_VIOLATION');
    });

    it('resolves a symlink to the filesystem root', () => {
      const link = path.join(dir, 'to-root');
      fs.symlinkSync('/', link);
      expect(code(() => assertBindSource(link))).toBe('POLICY_VIOLATION');
    });

    it('refuses ANY unix socket, whatever it is called, directly or through a link', async () => {
      const sock = path.join(dir, 'agent.sock');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(sock, resolve));
      try {
        expect(code(() => assertBindSource(sock))).toBe('POLICY_VIOLATION');
        const link = path.join(dir, 'link-to-agent-sock');
        fs.symlinkSync(sock, link);
        expect(code(() => assertBindSource(link))).toBe('POLICY_VIOLATION');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('still accepts an ordinary directory, and a symlink to one', () => {
      const real = path.join(dir, 'work');
      fs.mkdirSync(real);
      const link = path.join(dir, 'work-link');
      fs.symlinkSync(real, link);
      expect(assertBindSource(real)).toBe(real);
      expect(assertBindSource(link)).toBe(link);
    });
  });

  it('refuses the docker socket and the filesystem root (host takeover)', () => {
    expect(code(() => assertBindSource('/var/run/docker.sock'))).toBe('POLICY_VIOLATION');
    expect(code(() => assertBindSource('/run/docker.sock'))).toBe('POLICY_VIOLATION');
    expect(code(() => assertBindSource('/run/containerd/containerd.sock'))).toBe('POLICY_VIOLATION');
    expect(code(() => assertBindSource('/'))).toBe('POLICY_VIOLATION');
    // A traversal that resolves to the socket is still caught.
    expect(code(() => assertBindSource('/tmp/../var/run/docker.sock'))).toBe('POLICY_VIOLATION');
  });
});

describe('env / secret / volume-key names', () => {
  it('env names follow POSIX rules', () => {
    expect(assertEnvName('ANTHROPIC_API_KEY')).toBe('ANTHROPIC_API_KEY');
    for (const bad of ['', '1X', 'A=B', 'A B', 'A-B', '../x', 'A\nB']) {
      expect(code(() => assertEnvName(bad))).toBe('INVALID_INPUT');
    }
  });

  it('secret names are lowercase service names', () => {
    expect(assertSecretName('anthropic')).toBe('anthropic');
    for (const bad of ['', 'Anthropic', '1x', '../x', 'a b', 'a=b', 'a.b', 'a_b']) {
      expect(code(() => assertSecretName(bad))).toBe('INVALID_INPUT');
    }
  });

  it('volume keys are safe docker name fragments', () => {
    expect(assertVolumeKey('data')).toBe('data');
    for (const bad of ['', '-x', 'a/b', 'a b', 'a'.repeat(33)]) {
      expect(code(() => assertVolumeKey(bad))).toBe('INVALID_INPUT');
    }
  });
});

describe('secretEnvName', () => {
  it('maps secret names to the sidecar env var', () => {
    expect(secretEnvName('anthropic')).toBe('AV_SECRET_ANTHROPIC');
    expect(secretEnvName('my-key')).toBe('AV_SECRET_MY_KEY');
  });

  it('validates the name (a hostile name must not become an env var)', () => {
    expect(code(() => secretEnvName('A=B'))).toBe('INVALID_INPUT');
    expect(code(() => secretEnvName('../x'))).toBe('INVALID_INPUT');
  });

  it('is injective: "_" is not a valid secret-name character, so "-" -> "_" cannot collide', () => {
    expect(code(() => assertSecretName('a_b'))).toBe('INVALID_INPUT');
    expect(code(() => secretEnvName('a_b'))).toBe('INVALID_INPUT');
    expect(secretEnvName('a-b')).toBe('AV_SECRET_A_B');
  });
});

describe('parseUser', () => {
  it('parses numeric uid:gid', () => {
    expect(parseUser('10001:10001')).toEqual({ uid: 10001, gid: 10001 });
    expect(parseUser('0:0')).toEqual({ uid: 0, gid: 0 });
  });

  it.each(['', 'agent', '1000', '1000:', ':1000', 'root:root', '1000:1000:1', '-1:5'])('rejects %j', (bad) => {
    expect(code(() => parseUser(bad))).toBe('INVALID_INPUT');
  });
});

describe('resourceNames', () => {
  it('derives deterministic, prefixed names', () => {
    const n = resourceNames('my-agent');
    expect(n.container).toBe('av-my-agent');
    expect(n.proxy).toBe('av-my-agent-proxy');
    expect(n.network).toBe('av-my-agent-net');
    expect(n.egress).toBe('av-my-agent-egress');
    expect(n.volume('data')).toBe('av-my-agent-data');
  });

  it('validates the agent name and volume key', () => {
    expect(code(() => resourceNames('../x'))).toBe('INVALID_INPUT');
    expect(code(() => resourceNames('ok').volume('../x'))).toBe('INVALID_INPUT');
  });
});

describe('volumeKeyForPath', () => {
  it('maps container paths to keys', () => {
    expect(volumeKeyForPath('/data')).toBe('data');
    // Runs of separators collapse, so the dot in ".cache" does not leave "--".
    expect(volumeKeyForPath('/home/agent/.cache')).toBe('home-agent-cache');
  });

  it('rejects the root path and bad paths', () => {
    expect(code(() => volumeKeyForPath('/'))).toBe('INVALID_INPUT');
    expect(code(() => volumeKeyForPath('data'))).toBe('INVALID_INPUT');
  });
});

describe('volumeKeysForPaths', () => {
  it('pairs each path with its key', () => {
    expect(volumeKeysForPaths(['/data', '/memory'])).toEqual([
      { key: 'data', containerPath: '/data' },
      { key: 'memory', containerPath: '/memory' },
    ]);
  });

  it('refuses paths whose keys collide (they would share one volume)', () => {
    expect(code(() => volumeKeysForPaths(['/a/b', '/a-b']))).toBe('INVALID_INPUT');
    expect(code(() => volumeKeysForPaths(['/Data', '/data']))).toBe('INVALID_INPUT');
  });
});

describe('agentvaultHome', () => {
  it('honours an absolute AGENTVAULT_HOME at call time', () => {
    expect(agentvaultHome({ AGENTVAULT_HOME: '/tmp/x' })).toBe('/tmp/x');
  });

  it('ignores a relative override (would depend on cwd)', () => {
    expect(agentvaultHome({ AGENTVAULT_HOME: 'rel' })).toMatch(/\.agentvault$/);
  });

  it('defaults to ~/.agentvault', () => {
    expect(agentvaultHome({})).toMatch(/\.agentvault$/);
  });
});
