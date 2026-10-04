/**
 * How AgentVault starts Polytician: the namespace every call goes to, and the
 * AgentVault settings (POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN) it
 * passes on from its own environment so Polytician registers its vault_* tools.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkPolyticianNamespace,
  defaultPolyticianNamespace,
  isAllowedAgentVaultUrl,
  polyticianAgentVaultEnv,
  polyticianServerConfig,
  PolyticianConfigError,
  DEFAULT_POLYTICIAN_NAMESPACE,
  POLYTICIAN_SERVER_LABEL,
} from '../../src/orchestration/polytician-config.js';
import { nearestProjectAgentId } from '../../src/hypervault/pipeline.js';
import { serverEnvironment, WITHHELD_SERVER_ENV } from '../../src/orchestration/mcp-client.js';
import { IDENTITY_PEM_ENV, IDENTITY_PEM_FILE_ENV } from '../../src/canister/identity.js';

const TOKEN = 'av-token-0123456789abcdef';

describe('polyticianAgentVaultEnv', () => {
  it('passes AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN on as POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN', () => {
    expect(polyticianAgentVaultEnv({ AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN }))
      .toEqual({ POLYTICIAN_AV_API_URL: 'https://vault.example.com', POLYTICIAN_AV_API_TOKEN: TOKEN });
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000/', 'http://[::1]:3000'])('allows plain http to this machine (%s)', (url) => {
    expect(polyticianAgentVaultEnv({ AGENTVAULT_API_URL: url, AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN }))
      .toEqual({ POLYTICIAN_AV_API_URL: url, POLYTICIAN_AV_API_TOKEN: TOKEN });
  });

  it("injects nothing when the operator set Polytician's own settings: they win, and AgentVault's token never goes to a URL it did not choose", () => {
    const agentVault = { AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN };
    expect(polyticianAgentVaultEnv({ ...agentVault, POLYTICIAN_AV_API_URL: 'https://other.example.com' })).toEqual({});
    expect(polyticianAgentVaultEnv({ ...agentVault, POLYTICIAN_AV_API_TOKEN: 'operator-token' })).toEqual({});
  });

  it('injects nothing unless both AgentVault settings are set', () => {
    expect(polyticianAgentVaultEnv({})).toEqual({});
    expect(polyticianAgentVaultEnv({ AGENTVAULT_API_URL: 'https://vault.example.com' })).toEqual({});
    expect(polyticianAgentVaultEnv({ AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN })).toEqual({});
    expect(polyticianAgentVaultEnv({ AGENTVAULT_API_URL: '', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN })).toEqual({});
  });

  it('refuses a URL Polytician would refuse, saying why, without the token or the credentials in the URL', () => {
    const attempt = (url: string) => {
      try {
        polyticianAgentVaultEnv({ AGENTVAULT_API_URL: url, AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN });
      } catch (error) {
        return error;
      }
      throw new Error(`${url} was accepted`);
    };

    const plainHttp = attempt('http://admin:hunter2@vault.example.com:8080/base');
    expect(plainHttp).toBeInstanceOf(PolyticianConfigError);
    const message = (plainHttp as Error).message;
    expect(message).toContain('AGENTVAULT_API_URL');
    expect(message).toContain('http://vault.example.com:8080');
    expect(message).toMatch(/https/);
    expect(message).toMatch(/localhost/);
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(TOKEN);

    expect((attempt('vault.example.com') as Error).message).toMatch(/AGENTVAULT_API_URL is not an absolute URL/);
    expect((attempt('ftp://vault.example.com') as Error).message).toContain('ftp://vault.example.com');
  });
});

describe('AgentVault URLs carrying credentials', () => {
  // Node's fetch refuses a URL with user info, so every vault_* call would
  // fail, and Polytician repeats the whole URL, password included, in the error
  it.each([
    'https://user:s3cret@vault.example.com',
    'https://user@vault.example.com',
    'http://user:s3cret@127.0.0.1:3000',
  ])('are refused before Polytician starts, without repeating the user info (%s)', (url) => {
    let caught: unknown;
    try {
      polyticianAgentVaultEnv({ AGENTVAULT_API_URL: url, AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PolyticianConfigError);
    const message = (caught as Error).message;
    expect(message).toMatch(/AGENTVAULT_API_URL .*credentials/s);
    expect(message).toMatch(/API token/);
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('user');
  });
});

describe('empty POLYTICIAN_AV_* settings', () => {
  it("count as unset, as they do for Polytician, so AgentVault's settings are still passed on", () => {
    const agentVault = { AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN };
    const injected = { POLYTICIAN_AV_API_URL: 'https://vault.example.com', POLYTICIAN_AV_API_TOKEN: TOKEN };
    expect(polyticianAgentVaultEnv({ ...agentVault, POLYTICIAN_AV_API_URL: '' })).toEqual(injected);
    expect(polyticianAgentVaultEnv({ ...agentVault, POLYTICIAN_AV_API_TOKEN: '' })).toEqual(injected);
    expect(polyticianAgentVaultEnv({ ...agentVault, POLYTICIAN_AV_API_URL: '', POLYTICIAN_AV_API_TOKEN: '' })).toEqual(injected);
  });
});

describe('nearestProjectAgentId', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tree(): string {
    dir = mkdtempSync(join(tmpdir(), 'av-agent-name-'));
    return dir;
  }

  it('finds the agent name from a subdirectory of the project', () => {
    const root = tree();
    writeFileSync(join(root, 'agent.json'), JSON.stringify({ name: 'agent-a' }));
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    expect(nearestProjectAgentId(nested)).toBe('agent-a');
    expect(nearestProjectAgentId(root)).toBe('agent-a');
  });

  it('reads .agentvault/config/agent.config.json, and the nearest project wins', () => {
    const root = tree();
    writeFileSync(join(root, 'agent.json'), JSON.stringify({ name: 'outer' }));
    const inner = join(root, 'packages', 'inner');
    mkdirSync(join(inner, '.agentvault', 'config'), { recursive: true });
    writeFileSync(join(inner, '.agentvault', 'config', 'agent.config.json'), JSON.stringify({ name: 'inner' }));
    mkdirSync(join(inner, 'lib'));

    expect(nearestProjectAgentId(join(inner, 'lib'))).toBe('inner');
  });

  it('is undefined outside any project', () => {
    const root = tree();
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    expect(nearestProjectAgentId(join(root, 'a', 'b'))).toBeUndefined();
  });
});

describe('isAllowedAgentVaultUrl (as Polytician checks POLYTICIAN_AV_API_URL)', () => {
  it.each([
    ['https://vault.example.com', true],
    ['https://vault.example.com:8443/av', true],
    ['http://localhost', true],
    ['http://127.0.0.1:3000', true],
    ['http://[::1]:3000', true],
    ['http://vault.example.com', false],
    ['http://127.0.0.2:3000', false],
    ['ws://localhost', false],
    ['not a url', false],
  ])('%s → %s', (url, allowed) => {
    expect(isAllowedAgentVaultUrl(url)).toBe(allowed);
  });
});

describe('Polytician namespaces', () => {
  it.each(['default', 'my-agent', 'a', 'Agent.v2:prod_1-x', 'x'.repeat(64)])('accepts %s', (namespace) => {
    expect(checkPolyticianNamespace(namespace, '--namespace')).toBe(namespace);
  });

  it.each(['', '-agent', '.agent', 'my agent', 'agent/1', 'agënt', 'x'.repeat(65)])('refuses %j, naming where it came from and the rule', (namespace) => {
    expect(() => checkPolyticianNamespace(namespace, '--namespace')).toThrow(PolyticianConfigError);
    expect(() => checkPolyticianNamespace(namespace, '--namespace')).toThrow(/--namespace .*not a valid Polytician namespace.*1-64/s);
  });

  it("defaults to the project's agent name, which is the webapp's agentId for that agent, else to \"default\"", () => {
    expect(defaultPolyticianNamespace('my-agent', '--namespace')).toBe('my-agent');
    expect(defaultPolyticianNamespace(undefined, '--namespace')).toBe(DEFAULT_POLYTICIAN_NAMESPACE);
    expect(DEFAULT_POLYTICIAN_NAMESPACE).toBe('default');
  });

  it('refuses an agent name that cannot be a namespace instead of falling back to the shared one', () => {
    expect(() => defaultPolyticianNamespace('My Agent', '--polytician-namespace'))
      .toThrow(/agent name "My Agent".*not a valid Polytician namespace.*--polytician-namespace/s);
  });
});

describe('polyticianServerConfig', () => {
  it('keeps the server label apart from the Polytician namespace, and adds the AgentVault settings to the child environment', () => {
    const config = polyticianServerConfig(
      { entryPoint: 'node polytician.js', namespace: 'agent-a' },
      { AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN },
    );
    expect(config).toEqual({
      namespace: POLYTICIAN_SERVER_LABEL,
      entryPoint: 'node polytician.js',
      polyticianNamespace: 'agent-a',
      env: { POLYTICIAN_AV_API_URL: 'https://vault.example.com', POLYTICIAN_AV_API_TOKEN: TOKEN },
    });
  });

  it('passes the config file as an absolute path and keeps an explicit env, which wins over injection', () => {
    const config = polyticianServerConfig(
      { entryPoint: 'node polytician.js', namespace: 'agent-a', configPath: 'poly/config.json', env: { POLYTICIAN_AV_API_URL: 'https://mine.example.com' } },
      { AGENTVAULT_API_URL: 'https://vault.example.com', AGENTVAULT_POLYTICIAN_API_TOKEN: TOKEN },
    );
    expect(config.configPath).toBe(`${process.cwd()}/poly/config.json`);
    expect(config.env).toEqual({ POLYTICIAN_AV_API_URL: 'https://mine.example.com' });
  });

  it('has no env when there is nothing to add', () => {
    expect(polyticianServerConfig({ entryPoint: 'node polytician.js', namespace: 'default' }, {})).toEqual({
      namespace: POLYTICIAN_SERVER_LABEL,
      entryPoint: 'node polytician.js',
      polyticianNamespace: 'default',
    });
  });

  it('refuses an invalid namespace before anything is started', () => {
    expect(() => polyticianServerConfig({ entryPoint: 'node polytician.js', namespace: 'no spaces' }, {}))
      .toThrow(PolyticianConfigError);
  });
});

describe('the environment Polytician is started with', () => {
  it("is AgentVault's, with the server's own settings over it, minus AgentVault's signing key and wallet secrets", () => {
    expect(WITHHELD_SERVER_ENV).toEqual(expect.arrayContaining([IDENTITY_PEM_ENV, IDENTITY_PEM_FILE_ENV]));
    const secrets = Object.fromEntries(WITHHELD_SERVER_ENV.map((name) => [name, `secret-${name}`]));

    const env = serverEnvironment(
      { env: { POLYTICIAN_AV_API_URL: 'https://vault.example.com', AGENTVAULT_ICP_IDENTITY_PEM: 'from-config' } },
      { PATH: '/usr/bin', HOME: '/home/agent', ...secrets },
    );

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/agent', POLYTICIAN_AV_API_URL: 'https://vault.example.com', MCP_MODE: 'stdio' });
  });
});
