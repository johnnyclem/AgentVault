/**
 * loadProxyScript: the sidecar program as one string. Proves it works from the
 * TypeScript source (tsx/vitest) AND from real `tsc` output (what ships in dist/).
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SCRIPT_BYTES, loadProxyScript } from '../../../src/container/proxy/bundle.js';
import { PROXY_CONFIG_ENV } from '../../../src/container/types.js';
import { send, spawnSidecar } from './harness.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const sidecarEnv = (port = 0): Record<string, string> => ({
  [PROXY_CONFIG_ENV]: JSON.stringify({
    version: 1,
    listenPort: port,
    routes: [{ name: 'anthropic', pathPrefix: '/anthropic', upstream: 'https://api.anthropic.com', inject: [{ header: 'x-api-key', secret: 'anthropic' }] }],
    maxBodyBytes: 1024,
    upstreamTimeoutMs: 5000,
  }),
  AV_SECRET_ANTHROPIC: 'sk-bundle-test-key',
});

function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of source.matchAll(re)) found.add(match[1]!);
  }
  return [...found].sort();
}

describe('loadProxyScript from the TypeScript source', () => {
  it('is one ESM script under the argv limit, with no shebang and no source map', async () => {
    const script = await loadProxyScript();
    expect(typeof script).toBe('string');
    expect(Buffer.byteLength(script)).toBeLessThan(100 * 1024);
    expect(MAX_SCRIPT_BYTES).toBe(100 * 1024);
    expect(script.startsWith('#!')).toBe(false);
    expect(script).not.toContain('sourceMappingURL');
    expect(script).not.toMatch(/\brequire\s*\(/);
    expect(script).toContain('listening');
  });

  it('imports nothing but node: built-ins (it runs with no node_modules)', async () => {
    const specifiers = importSpecifiers(await loadProxyScript());
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier.startsWith('node:'), specifier).toBe(true);
  });

  it('is memoized', async () => {
    expect(loadProxyScript()).toBe(loadProxyScript());
    expect(await loadProxyScript()).toBe(await loadProxyScript());
  });

  it('carries no secrets and no host paths', async () => {
    const script = await loadProxyScript();
    expect(script).not.toContain(repoRoot);
    expect(script).not.toContain(os.homedir());
    expect(script).not.toContain('sk-');
  });

  it('runs under `node --input-type=module -e` from an empty directory and serves traffic', async () => {
    const script = await loadProxyScript();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-d-bare-'));
    const sidecar = spawnSidecar(script, sidecarEnv(), bare);
    try {
      const port = await sidecar.listening();
      expect(sidecar.lines[0]).toBe(`{"event":"listening","port":${port}}`);
      expect((await send({ port, path: '/_agentvault/health' })).text).toBe('{"ok":true}');
    } finally {
      sidecar.kill();
      await sidecar.exited;
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('loadProxyScript from compiled output (dist mode)', () => {
  let scratch: string;
  let compiledProxy: string;
  let compiledBundle: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-d-dist-'));
    const outDir = path.join(scratch, 'out');
    const tsconfig = path.join(scratch, 'tsconfig.json');
    fs.writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: path.join(repoRoot, 'tsconfig.json'),
        compilerOptions: {
          outDir,
          rootDir: repoRoot,
          noEmit: false,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          typeRoots: [path.join(repoRoot, 'node_modules/@types')],
          types: ['node'],
        },
        include: [],
        files: [path.join(repoRoot, 'src/container/proxy/bundle.ts'), path.join(repoRoot, 'src/container/proxy/credential-proxy.ts')],
      })
    );
    // The real compiler, exactly as `npm run build` uses it (that script is bare `tsc`).
    const tsc = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
    execFileSync(process.execPath, [tsc, '-p', tsconfig], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
    // So that `import 'esbuild'` resolves from the scratch tree the way it does from dist/.
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(scratch, 'node_modules'));
    compiledBundle = path.join(outDir, 'src/container/proxy/bundle.js');
    compiledProxy = path.join(outDir, 'src/container/proxy/credential-proxy.js');
  }, 120_000);

  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function scriptFromDist(): Promise<string> {
    const program = `import { loadProxyScript } from ${JSON.stringify(pathToFileURL(compiledBundle).href)}; process.stdout.write(await loadProxyScript());`;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', program], { cwd: scratch, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env['PATH'] ?? '' } });
    return stdout;
  }

  it('tsc emitted plain .js modules for both files', () => {
    expect(fs.existsSync(compiledBundle)).toBe(true);
    expect(fs.existsSync(compiledProxy)).toBe(true);
    expect(fs.readFileSync(compiledProxy, 'utf8')).not.toContain('import type');
  });

  it('the compiled credential-proxy.js imports only node: built-ins at runtime', () => {
    const specifiers = importSpecifiers(fs.readFileSync(compiledProxy, 'utf8'));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier.startsWith('node:'), specifier).toBe(true);
  });

  it('loads and bundles the sibling .js when bundle.js itself is the running module', async () => {
    const script = await scriptFromDist();
    expect(Buffer.byteLength(script)).toBeLessThan(100 * 1024);
    expect(script.startsWith('#!')).toBe(false);
    for (const specifier of importSpecifiers(script)) expect(specifier.startsWith('node:'), specifier).toBe(true);
  }, 30_000);

  it('the dist-derived script behaves as the sidecar: listens, serves health, fails closed', async () => {
    const script = await scriptFromDist();
    const sidecar = spawnSidecar(script, sidecarEnv(), scratch);
    try {
      const port = await sidecar.listening();
      expect((await send({ port, path: '/_agentvault/health' })).text).toBe('{"ok":true}');
      expect((await send({ port, path: '/anthropic/../x' })).status).toBe(400);
      expect((await send({ port, path: '/nope' })).status).toBe(404);
    } finally {
      sidecar.kill();
      await sidecar.exited;
    }
    const noSecret = sidecarEnv();
    delete noSecret['AV_SECRET_ANTHROPIC'];
    const failing = spawnSidecar(script, noSecret, scratch);
    expect((await failing.exited).code).toBe(1);
    expect(failing.stderr()).toContain('anthropic');
  }, 30_000);

  it('importing the compiled module starts nothing, even with a complete environment', async () => {
    const program = `const m = await import(${JSON.stringify(pathToFileURL(compiledProxy).href)}); process.stdout.write(Object.keys(m).sort().join(','));`;
    const started = Date.now();
    // If the guard were missing the module would bind a port and keep the process alive until killed.
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: scratch,
      timeout: 8_000,
      env: { PATH: process.env['PATH'] ?? '', ...sidecarEnv(0) },
    });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(stdout).toContain('createCredentialProxy');
    expect(stdout).toContain('runFromEnv');
    expect(stdout).not.toContain('listening');
  }, 15_000);
});
