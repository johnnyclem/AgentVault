/**
 * Turns credential-proxy.ts into the single self-contained script the sidecar runs.
 *
 * WHY: the sidecar is a bare node:22-slim container with no node_modules and no
 * build step, so the proxy has to travel as one string:
 *   node --input-type=module -e "<script>"
 * This reuses the esbuild dependency the packager already ships, so there is no
 * new build step, no extra file to publish, and the same code is type-checked,
 * linted and unit-tested as ordinary TypeScript.
 *
 * SECURITY STANCE: the script contains no secrets (those arrive through an
 * --env-file) and no network input is ever used to pick which file is bundled.
 * esbuild's `define` is the only thing that switches the entry point on, so
 * importing credential-proxy.ts anywhere else starts nothing.
 */

import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { ContainerError } from '../types.js';

/** `docker run ... -e <script>` puts the script in one argv entry; Linux caps that near 128 KiB. */
export const MAX_SCRIPT_BYTES = 100 * 1024;

let cached: Promise<string> | undefined;

/**
 * Path of the sibling credential-proxy module for the current run mode:
 * the .ts source under tsx/vitest, the compiled .js when running from dist/.
 */
function proxySourcePath(): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./credential-proxy.${extension}`, import.meta.url));
}

async function bundleProxy(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [proxySourcePath()],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'silent',
    // Do not let esbuild pick up an unrelated tsconfig.json from a parent directory.
    tsconfigRaw: '{}',
    define: { __AV_PROXY_AUTOSTART__: 'true' },
  });
  const output = result.outputFiles[0];
  if (result.outputFiles.length !== 1 || output === undefined) {
    throw new ContainerError('COMMAND_FAILED', 'Credential proxy bundle did not produce exactly one file');
  }
  const script = output.text;
  if (Buffer.byteLength(script) >= MAX_SCRIPT_BYTES) {
    throw new ContainerError('COMMAND_FAILED', `Credential proxy script is ${Buffer.byteLength(script)} bytes; the limit is ${MAX_SCRIPT_BYTES}`);
  }
  return script;
}

/**
 * The sidecar program as ESM source text (no shebang). Memoized per process;
 * a failed build is not cached.
 */
export function loadProxyScript(): Promise<string> {
  if (cached === undefined) {
    cached = bundleProxy().catch((err: unknown) => {
      cached = undefined;
      if (err instanceof ContainerError) throw err;
      throw new ContainerError('COMMAND_FAILED', `Could not bundle the credential proxy: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return cached;
}
