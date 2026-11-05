/**
 * Container manifest (PRD-02 §3.4).
 *
 * The manifest is written to `<output>/agentvault.json` AND embedded in the
 * image as the `agentvault.manifest` label, so an image is self-describing:
 * `agentvault run <image>` and reconstruction on a clean machine need nothing
 * but the image.
 *
 * Deliberately NOT written into the agent's source root: `agentvault.json` is
 * already one of the filenames detectAgent()/parseGenericConfig() read as a
 * *generic agent config*, so a manifest there would be re-parsed as one.
 * `env` and `secrets` hold NAMES only, never values.
 */

import { z } from 'zod';
import { ContainerError, DEFAULT_AGENT_USER, LABEL_MANIFEST } from './types.js';
import { AGENT_NAME_RE, CONTAINER_PATH_RE, ENV_NAME_RE, SECRET_NAME_RE } from './validate.js';

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILE = 'agentvault.json';
export { LABEL_MANIFEST };

const containerPathSchema = z
  .string()
  .regex(CONTAINER_PATH_RE)
  .refine((p) => p !== '/' && !p.split('/').includes('..') && !p.endsWith('/'), 'path must be normalized and not "/"');

export const containerManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    name: z.string().regex(AGENT_NAME_RE),
    version: z.string().min(1).max(64),
    runtime: z.enum(['node', 'python']),
    /** Exec-form argv. Never a shell string. */
    entrypoint: z.array(z.string().min(1).max(4096)).min(1).max(64),
    /** Container paths that are persisted in named volumes. */
    volumes: z.array(containerPathSchema).max(16),
    /** Environment variable NAMES the agent reads (values are never stored). */
    env: z.array(z.string().regex(ENV_NAME_RE)).max(64),
    /** Credential-proxy service names the agent needs (e.g. "anthropic"). */
    secrets: z.array(z.string().regex(SECRET_NAME_RE)).max(16),
    healthcheck: z
      .object({
        test: z.array(z.string().min(1).max(1024)).min(1).max(32),
        intervalSec: z.number().int().min(1).max(3600).optional(),
        timeoutSec: z.number().int().min(1).max(3600).optional(),
        retries: z.number().int().min(1).max(20).optional(),
        startPeriodSec: z.number().int().min(0).max(3600).optional(),
      })
      .strict()
      .optional(),
    isolation: z
      .object({
        network: z.enum(['none', 'proxy', 'bridge']),
        user: z.string().regex(/^\d{1,10}:\d{1,10}$/),
        readOnlyRootfs: z.boolean(),
      })
      .strict(),
    source: z
      .object({
        type: z.string().min(1).max(32),
        /** sha256 over the staged build context (reproducibility). */
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export type ContainerManifest = z.infer<typeof containerManifestSchema>;

/**
 * Parse untrusted manifest JSON (from an image label or a file). Checks
 * schemaVersion first so a newer manifest yields a clear message instead of a
 * wall of zod errors, and refuses a root user.
 */
export function parseManifest(raw: string | unknown): ContainerManifest {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ContainerError('INVALID_INPUT', 'Container manifest is not valid JSON');
    }
  }
  if (typeof data === 'object' && data !== null && 'schemaVersion' in data) {
    const v = (data as { schemaVersion: unknown }).schemaVersion;
    if (v !== MANIFEST_SCHEMA_VERSION) {
      throw new ContainerError(
        'INVALID_INPUT',
        `Unsupported container manifest schemaVersion ${JSON.stringify(v)} (this AgentVault understands ${MANIFEST_SCHEMA_VERSION}); upgrade AgentVault`
      );
    }
  }
  const result = containerManifestSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first ? first.path.join('.') || '(root)' : '(root)';
    throw new ContainerError('INVALID_INPUT', `Invalid container manifest at ${where}: ${first?.message ?? 'unknown error'}`);
  }
  const manifest = result.data;
  if (manifest.isolation.user.startsWith('0:') || manifest.isolation.user === '0') {
    throw new ContainerError('POLICY_VIOLATION', 'Container manifest requests uid 0; agents must run as non-root');
  }
  return manifest;
}

/** Serialize for the image label (single line, stable key order). */
export function manifestToLabel(manifest: ContainerManifest): string {
  return JSON.stringify(containerManifestSchema.parse(manifest));
}

/** Read the manifest out of an image's labels, or null if it is not one of ours. */
export function manifestFromLabels(labels: Record<string, string>): ContainerManifest | null {
  const raw = labels[LABEL_MANIFEST];
  return raw === undefined ? null : parseManifest(raw);
}

/** Defaults used by the packager. */
export const DEFAULT_ISOLATION = {
  network: 'none' as const,
  user: DEFAULT_AGENT_USER,
  readOnlyRootfs: true,
};
