/**
 * Shared helpers for integration tests that need a REAL Docker daemon.
 *
 * Usage:
 *   const d = dockerTestEnv('avt-x-');
 *   describe.skipIf(!d.available)('...', () => {
 *     afterAll(() => d.cleanup());
 *     it('...', async () => { const agent = d.name('a'); ... });
 *   });
 *
 * Rules every integration test must follow:
 *  - name everything with d.name()/d.agent() so cleanup() can find it;
 *  - call d.cleanup() in afterAll (it is idempotent and never throws);
 *  - skip (not fail) when no daemon is reachable, so CI without Docker stays green.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function docker(args: string[], timeoutMs = 30_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let availableCache: boolean | undefined;

export function dockerAvailable(): boolean {
  if (availableCache === undefined) {
    availableCache = docker(['info', '--format', '{{.ServerVersion}}'], 8_000).status === 0;
  }
  return availableCache;
}

export function imagePresent(ref: string): boolean {
  return docker(['image', 'inspect', ref, '--format', '{{.Id}}'], 8_000).status === 0;
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface DockerTestEnv {
  readonly available: boolean;
  readonly prefix: string;
  /** A unique docker-safe name: `<prefix><label>-<6 hex>`. */
  name(label: string): string;
  /** A unique AgentVault agent name (valid for assertAgentName). */
  agent(label?: string): string;
  /** Remove every container/volume/network/image whose name starts with the prefix, or that belongs to a tracked agent. */
  cleanup(): void;
}

export function dockerTestEnv(prefix: string): DockerTestEnv {
  const agents = new Set<string>();
  const available = dockerAvailable();

  const owns = (name: string): boolean => {
    if (name.startsWith(prefix)) return true;
    for (const a of agents) {
      // av-<agent>, av-<agent>-proxy, av-<agent>-net, av-<agent>-<volume key>
      if (name === `av-${a}` || name.startsWith(`av-${a}-`)) return true;
    }
    return false;
  };

  return {
    available,
    prefix,
    name(label: string): string {
      return `${prefix}${label}-${randomBytes(3).toString('hex')}`;
    },
    agent(label = 'agent'): string {
      const a = `${prefix}${label}-${randomBytes(3).toString('hex')}`.toLowerCase();
      agents.add(a);
      return a;
    },
    cleanup(): void {
      if (!available) return;
      try {
        const containers = lines(docker(['ps', '-a', '--format', '{{.Names}}']).stdout).filter(owns);
        if (containers.length > 0) docker(['rm', '-f', ...containers], 60_000);
        const networks = lines(docker(['network', 'ls', '--format', '{{.Name}}']).stdout).filter(owns);
        if (networks.length > 0) docker(['network', 'rm', ...networks], 30_000);
        const volumes = lines(docker(['volume', 'ls', '--format', '{{.Name}}']).stdout).filter(owns);
        if (volumes.length > 0) docker(['volume', 'rm', '-f', ...volumes], 30_000);
        const images = lines(docker(['images', '--format', '{{.Repository}}:{{.Tag}}']).stdout).filter(
          (r) => r.startsWith(prefix) || r.startsWith(`agentvault/${prefix}`)
        );
        if (images.length > 0) docker(['rmi', '-f', ...images], 60_000);
      } catch {
        // cleanup must never fail a test run
      }
    },
  };
}
