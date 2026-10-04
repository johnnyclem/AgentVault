/**
 * Polytician 3.0.0's AgentVaultConfigSchema (src/integrations/agent-vault/config.ts),
 * mirrored in AgentVault's zod so the tests can check the config file
 * `agentvault polytician config` writes without Polytician's build. Polytician
 * parses the file's agentVault section with it at startup and refuses to start
 * when it does not match. tests/unit/polytician-config-file.test.ts also runs
 * Polytician's own schema when POLYTICIAN_ENTRY names a built server.
 */

import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAllowedEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

export const AgentVaultConfigSchema = z
  .object({
    apiBaseUrl: z.string().url().refine(isAllowedEndpoint, 'must use https (plain http is allowed only for localhost)'),
    apiToken: z.string().optional(),
    agentPrincipal: z.string().optional(),
    memoryRepoBranch: z.string().default('polytician-main'),
    inference: z
      .object({
        preferredBackend: z.enum(['bittensor', 'venice', 'local']).optional(),
        timeoutMs: z.number().int().positive().default(30_000),
        maxRetries: z.number().int().min(0).default(2),
      })
      .default({ timeoutMs: 30_000, maxRetries: 2 }),
    sync: z
      .object({
        enabled: z.boolean().default(false),
        direction: z.enum(['push', 'pull', 'bidirectional']).default('push'),
        pullIntervalMs: z.number().int().min(0).default(0),
      })
      .default({ enabled: false, direction: 'push', pullIntervalMs: 0 }),
    archival: z
      .object({
        enabled: z.boolean().default(false),
        tagFilter: z.array(z.string().min(1)).default([]),
        debounceMs: z.number().int().min(0).default(5_000),
        arweaveJwk: z.string().optional(),
        timeoutMs: z.number().int().positive().default(120_000),
      })
      .default({ enabled: false, tagFilter: [], debounceMs: 5_000, timeoutMs: 120_000 }),
  })
  .superRefine((config, ctx) => {
    if (config.archival.enabled && config.archival.tagFilter.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['archival', 'tagFilter'],
        message: 'archival.enabled requires a non-empty archival.tagFilter',
      });
    }
  });
