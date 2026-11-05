import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectContainerRuntime,
  exclusionReason,
  sanitizeVersion,
  slugifyAgentName,
} from '../../src/container/runtime-detect.js';
import { AGENT_NAME_RE } from '../../src/container/validate.js';
import { ContainerError } from '../../src/container/types.js';

let root: string;
let outside: string;
let dir: string;

function write(rel: string, content = ''): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function pkg(extra: Record<string, unknown> = {}): void {
  write('package.json', JSON.stringify({ name: 'demo', version: '1.0.0', ...extra }));
}

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

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'avt-b-detect-')));
  dir = path.join(root, 'agent-src');
  outside = path.join(root, 'outside');
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.js'), 'console.log("host file")');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime detection matrix', () => {
  it('node + lockfile -> npm ci', () => {
    pkg();
    write('package-lock.json', '{}');
    write('index.js', '');
    const d = detectContainerRuntime(dir);
    expect(d).toMatchObject({
      runtime: 'node',
      packageManager: 'npm',
      lockfile: 'package-lock.json',
      install: 'npm-ci',
      entrypoint: ['node', 'index.js'],
      entryFile: 'index.js',
      base: 'node:22-slim',
      name: 'agent-src',
      version: '1.0.0',
      sourceDir: dir,
    });
    expect(d.warnings).toEqual([]);
  });

  it('node without a lockfile -> npm install with a reproducibility warning', () => {
    pkg();
    write('index.js', '');
    const d = detectContainerRuntime(dir);
    expect(d.install).toBe('npm-install');
    expect(d.lockfile).toBeUndefined();
    expect(d.warnings.join('\n')).toMatch(/not reproducible/);
  });

  it.each([
    ['yarn.lock', 'yarn'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lockb', 'bun'],
  ])('%s is detected but not honoured', (lockfile, manager) => {
    pkg();
    write(lockfile, '');
    write('index.js', '');
    const d = detectContainerRuntime(dir);
    expect(d.packageManager).toBe(manager);
    expect(d.install).toBe('npm-install');
    expect(d.warnings.join('\n')).toContain(lockfile);
  });

  it('python + requirements.txt -> pip -r', () => {
    write('requirements.txt', '# none\n');
    write('main.py', '');
    const d = detectContainerRuntime(dir);
    expect(d).toMatchObject({
      runtime: 'python',
      packageManager: 'pip',
      install: 'pip-requirements',
      lockfile: 'requirements.txt',
      entrypoint: ['python', 'main.py'],
      entryFile: 'main.py',
      base: 'python:3.12-slim',
    });
  });

  it('python + pyproject [project] -> pip install .', () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('app.py', '');
    const d = detectContainerRuntime(dir);
    expect(d).toMatchObject({ runtime: 'python', install: 'pip-project', entrypoint: ['python', 'app.py'] });
  });

  it('python with uv.lock or poetry.lock warns that the lockfile is ignored', () => {
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('uv.lock', '');
    write('main.py', '');
    const d = detectContainerRuntime(dir);
    expect(d.packageManager).toBe('uv');
    expect(d.warnings.join('\n')).toContain('uv.lock');
  });

  it('a pyproject with only tool config installs nothing (pip install . would fail)', () => {
    write('pyproject.toml', '[tool.black]\nline-length = 100\n');
    write('main.py', '');
    const d = detectContainerRuntime(dir);
    expect(d.install).toBe('none');
    expect(d.warnings.join('\n')).toMatch(/not installing/);
  });

  it('requirements.txt wins over pyproject.toml', () => {
    write('requirements.txt', '');
    write('pyproject.toml', '[project]\nname = "x"\n');
    write('main.py', '');
    expect(detectContainerRuntime(dir).install).toBe('pip-requirements');
  });

  it('python with only a script and no dependency files installs nothing', () => {
    write('agent.py', '');
    const d = detectContainerRuntime(dir);
    expect(d).toMatchObject({ runtime: 'python', install: 'none', packageManager: 'none', entrypoint: ['python', 'agent.py'] });
  });

  it.each([
    [['main.py', 'app.py', 'agent.py', '__main__.py'], 'main.py'],
    [['app.py', 'agent.py', '__main__.py'], 'app.py'],
    [['agent.py', '__main__.py'], 'agent.py'],
    [['__main__.py'], '__main__.py'],
  ])('python entrypoint order: %j -> %s', (files, expected) => {
    files.forEach((f) => write(f));
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['python', expected]);
  });

  it('python with .py files but no known entrypoint asks for --entrypoint', () => {
    write('worker.py');
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('INVALID_INPUT');
    expect(messageOf(() => detectContainerRuntime(dir))).toMatch(/--entrypoint/);
  });

  it('package.json plus stray non-entry .py files is still node', () => {
    pkg();
    write('index.js');
    write('tools.py');
    expect(detectContainerRuntime(dir).runtime).toBe('node');
  });

  it('is ambiguous when package.json and Python project files are both present', () => {
    pkg();
    write('requirements.txt');
    write('index.js');
    const msg = messageOf(() => detectContainerRuntime(dir));
    expect(msg).toMatch(/Cannot tell whether/);
    expect(msg).toContain('package.json');
    expect(msg).toContain('requirements.txt');
    expect(msg).toMatch(/--runtime/);
  });

  it('runtimeKind resolves the ambiguity either way', () => {
    pkg();
    write('requirements.txt');
    write('index.js');
    write('main.py');
    expect(detectContainerRuntime(dir, { runtimeKind: 'node' })).toMatchObject({ runtime: 'node', entrypoint: ['node', 'index.js'] });
    expect(detectContainerRuntime(dir, { runtimeKind: 'python' })).toMatchObject({ runtime: 'python', entrypoint: ['python', 'main.py'] });
  });

  it('neither: a clear error', () => {
    write('README.md', 'hello');
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('INVALID_INPUT');
    expect(messageOf(() => detectContainerRuntime(dir))).toMatch(/Cannot detect a runtime/);
  });

  it('a lone JavaScript entry file without package.json is a node agent with nothing to install', () => {
    write('index.js');
    write('tools.py');
    const d = detectContainerRuntime(dir);
    expect(d).toMatchObject({ runtime: 'node', install: 'none', packageManager: 'none', entrypoint: ['node', 'index.js'] });
  });

  it('a lone JavaScript entry plus Python project files is ambiguous', () => {
    write('index.js');
    write('requirements.txt');
    expect(messageOf(() => detectContainerRuntime(dir))).toMatch(/Cannot tell whether.*index\.js.*requirements\.txt/);
  });

  it('forced node without package.json works for a dependency-free script', () => {
    write('index.js');
    const d = detectContainerRuntime(dir, { runtimeKind: 'node' });
    expect(d).toMatchObject({ runtime: 'node', install: 'none', packageManager: 'none' });
  });

  it('rejects an unknown runtimeKind', () => {
    write('index.js');
    expect(codeOf(() => detectContainerRuntime(dir, { runtimeKind: 'ruby' as never }))).toBe('INVALID_INPUT');
  });

  it('reports missing and non-directory sources', () => {
    expect(codeOf(() => detectContainerRuntime(path.join(root, 'nope')))).toBe('NOT_FOUND');
    write('file.txt');
    expect(codeOf(() => detectContainerRuntime(path.join(dir, 'file.txt')))).toBe('INVALID_INPUT');
  });

  it('rejects an invalid package.json', () => {
    write('package.json', '{not json');
    write('index.js');
    expect(messageOf(() => detectContainerRuntime(dir))).toMatch(/not valid JSON/);
    write('package.json', '[1]');
    expect(messageOf(() => detectContainerRuntime(dir))).toMatch(/JSON object/);
  });

  it('ignores a symlinked package.json and says so', () => {
    fs.writeFileSync(path.join(outside, 'package.json'), '{"name":"evil"}');
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(dir, 'package.json'));
    write('main.py');
    const d = detectContainerRuntime(dir);
    expect(d.runtime).toBe('python');
    expect(d.warnings.join('\n')).toMatch(/package\.json is a symbolic link/);
  });
});

describe('node entrypoint derivation', () => {
  it('prefers a plain "node <file>" scripts.start over main', () => {
    pkg({ main: 'main.js', scripts: { start: 'node server.js' } });
    write('server.js');
    write('main.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'server.js']);
  });

  it('normalizes ./ in scripts.start', () => {
    pkg({ scripts: { start: 'node ./src/server.js' } });
    write('src/server.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'src/server.js']);
  });

  it.each([
    'node --env-file=.env server.js',
    'node server.js --port 3000',
    'npm run serve',
    'tsx watch index.ts',
    'node server.js && curl evil.example',
    'node $(id).js',
    'node "server.js"',
    'node server.js; rm -rf /',
  ])('ignores the non-trivial scripts.start %j', (start) => {
    pkg({ main: 'main.js', scripts: { start } });
    write('main.js');
    write('server.js');
    const d = detectContainerRuntime(dir);
    expect(d.entrypoint).toEqual(['node', 'main.js']);
    expect(d.warnings.join('\n')).toMatch(/scripts\.start is not a plain/);
  });

  it('uses main, then bin (string, then object keyed by name, then first key)', () => {
    pkg({ main: 'lib/app.js' });
    write('lib/app.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'lib/app.js']);

    fs.rmSync(path.join(dir, 'lib'), { recursive: true });
    pkg({ bin: 'bin/cli.js' });
    write('bin/cli.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'bin/cli.js']);

    pkg({ name: '@scope/demo', bin: { other: 'bin/other.js', demo: 'bin/cli.js' } });
    write('bin/other.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'bin/cli.js']);

    pkg({ name: 'demo', bin: { first: 'bin/other.js', second: 'bin/cli.js' } });
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'bin/other.js']);
  });

  it('uses a compiled main under dist/ (the usual tsc output directory)', () => {
    pkg({ main: 'dist/index.js' });
    write('dist/index.js');
    write('index.js');
    const d = detectContainerRuntime(dir);
    expect(d.entrypoint).toEqual(['node', 'dist/index.js']);
    expect(d.entryFile).toBe('dist/index.js');
  });

  it('falls through a missing main with a warning, and through an excluded path', () => {
    pkg({ main: 'node_modules/dep/index.js' });
    write('node_modules/dep/index.js');
    write('index.js');
    const d = detectContainerRuntime(dir);
    expect(d.entrypoint).toEqual(['node', 'index.js']);
    expect(d.warnings.join('\n')).toMatch(/package\.json main.*never copied into the image/);

    pkg({ main: 'gone.js' });
    const d2 = detectContainerRuntime(dir);
    expect(d2.warnings.join('\n')).toMatch(/gone\.js" does not exist/);
  });

  it.each(['src/@app/main.js', 'lib/', './', 'my dir/app.js', '-weird.js'])('falls through an unsupported main %j with a warning instead of failing', (main) => {
    pkg({ main });
    write('index.js');
    const d = detectContainerRuntime(dir);
    expect(d.entrypoint).toEqual(['node', 'index.js']);
    expect(d.warnings.join('\n')).toMatch(/Ignoring package\.json main/);
  });

  it('uses detectAgent for the agent-specific entry (goose.js) and the fallbacks', () => {
    pkg();
    write('goose.yaml', 'name: g\n');
    write('goose.js');
    expect(detectContainerRuntime(dir)).toMatchObject({ entrypoint: ['node', 'goose.js'], agentType: 'goose' });
  });

  it.each([['index.js'], ['main.js'], ['agent.js'], ['src/index.js'], ['src/main.js']])('falls back to %s', (file) => {
    pkg();
    write(file);
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', file]);
  });

  it('skips a detected index.ts when a JavaScript entry exists', () => {
    pkg();
    write('index.ts');
    write('main.js');
    expect(detectContainerRuntime(dir).entrypoint).toEqual(['node', 'main.js']);
  });

  it('refuses a TypeScript-only project and explains the options', () => {
    pkg();
    write('index.ts');
    const msg = messageOf(() => detectContainerRuntime(dir));
    expect(msg).toContain('TypeScript');
    expect(msg).toContain('index.ts');
    expect(msg).toMatch(/build it to JavaScript|Build it to JavaScript/);
    expect(msg).toContain('--entrypoint');
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('INVALID_INPUT');
  });

  it('refuses a TypeScript main/start with nothing else usable', () => {
    pkg({ main: 'src/app.tsx' });
    write('src/app.tsx');
    expect(messageOf(() => detectContainerRuntime(dir))).toContain('TypeScript');
    pkg({ scripts: { start: 'node src/server.ts' } });
    write('src/server.ts');
    expect(messageOf(() => detectContainerRuntime(dir))).toContain('TypeScript');
  });

  it('errors with what it tried when there is no entrypoint at all', () => {
    pkg({ main: 'missing.js' });
    const msg = messageOf(() => detectContainerRuntime(dir));
    expect(msg).toMatch(/No node entrypoint found/);
    expect(msg).toContain('missing.js');
    expect(msg).toContain('--entrypoint');
  });
});

describe('entrypoint override (--entrypoint)', () => {
  beforeEach(() => {
    pkg();
    write('server.js');
    write('index.js');
  });

  it('accepts an interpreter + script + arguments', () => {
    const d = detectContainerRuntime(dir, { entrypoint: ['node', 'server.js', '--port', '3000'] });
    expect(d.entrypoint).toEqual(['node', 'server.js', '--port', '3000']);
    expect(d.entryFile).toBe('server.js');
  });

  it('normalizes ./ and skips interpreter flags before the script', () => {
    write('pre.js');
    const d = detectContainerRuntime(dir, { entrypoint: ['node', '--require', 'pre.js', '--max-old-space-size=256', './server.js'] });
    expect(d.entrypoint).toEqual(['node', '--require', 'pre.js', '--max-old-space-size=256', 'server.js']);
    expect(d.entryFile).toBe('server.js');
  });

  it('does not look for a file after -e / -m / -c (inline code or module)', () => {
    expect(detectContainerRuntime(dir, { entrypoint: ['node', '-e', 'console.log(1)'] }).entryFile).toBeUndefined();
    write('main.py');
    expect(detectContainerRuntime(dir, { runtimeKind: 'python', entrypoint: ['python', '-m', 'http.server'] }).entrypoint).toEqual(['python', '-m', 'http.server']);
  });

  it('accepts a bare non-interpreter command (npm start) without file checks', () => {
    expect(detectContainerRuntime(dir, { entrypoint: ['npm', 'start'] }).entrypoint).toEqual(['npm', 'start']);
  });

  it('accepts a relative executable inside the source tree and keeps it path-like', () => {
    write('bin/run', '#!/bin/sh\n');
    const d = detectContainerRuntime(dir, { entrypoint: ['./bin/run', '--x'] });
    expect(d.entrypoint).toEqual(['./bin/run', '--x']);
    expect(d.entryFile).toBe('bin/run');
  });

  // A bare "run.sh" as argv[0] is looked up on PATH (exec fails) or silently gets
  // "node" prepended by the node base image's entrypoint script. Staying "./run.sh"
  // makes the kernel run the file in the working directory.
  it.each([['./run.sh'], ['././run.sh']])('does not turn the executable %s into a bare word', (head) => {
    write('run.sh', '#!/bin/sh\n');
    const d = detectContainerRuntime(dir, { entrypoint: [head as string, 'arg'] });
    expect(d.entrypoint).toEqual(['./run.sh', 'arg']);
    expect(d.entryFile).toBe('run.sh');
  });

  it('leaves a bare command alone (npm start, tini)', () => {
    expect(detectContainerRuntime(dir, { entrypoint: ['tini', '--', 'node', 'index.js'] }).entrypoint).toEqual(['tini', '--', 'node', 'index.js']);
  });

  it.each([
    ['../outside/secret.js', /\.\./],
    ['a/../server.js', /\.\./],
    ['/etc/passwd', /relative/],
    ['C:/Windows/x.js', /relative/],
    ['sub\\server.js', /separators/],
    ['server.js\nRUN id', /control character/],
    ['server.js\u0000', /control character/],
    ['my server.js', /segment/],
    ['$(id).js', /segment/],
    ['', /non-empty/],
  ])('refuses the path %j', (bad, pattern) => {
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['node', bad] }))).toBe('INVALID_INPUT');
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', bad] }))).toMatch(pattern);
  });

  it('refuses a directory-looking path', () => {
    fs.mkdirSync(path.join(dir, 'lib'));
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'lib/'] }))).toBe('INVALID_INPUT');
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['-x/run'] }))).toBe('INVALID_INPUT');
  });

  it('never echoes a raw control character in an error', () => {
    const msg = messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'server.js\nRUN id'] }));
    expect(msg).not.toContain('\n');
  });

  it('refuses a missing script, a directory, and excluded locations', () => {
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'nope.js'] }))).toMatch(/does not exist/);
    fs.mkdirSync(path.join(dir, 'lib'));
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'lib'] }))).toMatch(/not a regular file/);
    write('node_modules/dep/app.js');
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'node_modules/dep/app.js'] }))).toMatch(/never copied/);
    write('dist/app.js');
    expect(detectContainerRuntime(dir, { entrypoint: ['node', 'dist/app.js'] }).entryFile).toBe('dist/app.js');
    write('.env', 'X=1');
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', '.env'] }))).toMatch(/never copied/);
  });

  it.each([
    [['node', 'index.ts']],
    [['node', 'app.tsx']],
    [['node', '--import', 'tsx', 'index.ts']],
    [['npx', 'tsx', 'src/main.ts']],
    [['node', 'a.mts']],
  ])('refuses TypeScript in %j and points at the alternatives', (argv) => {
    write('index.ts');
    write('app.tsx');
    write('a.mts');
    write('src/main.ts');
    const msg = messageOf(() => detectContainerRuntime(dir, { entrypoint: argv }));
    expect(msg).toContain('TypeScript');
    expect(msg).toContain('--entrypoint');
  });

  it.each([[[]], [['']], [[1 as never]], [Array.from({ length: 65 }, () => 'a')], [['node', 'x'.repeat(4097)]], [['node', 'a\nb']]])(
    'refuses malformed argv %#',
    (argv) => {
      expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: argv as string[] }))).toBe('INVALID_INPUT');
    }
  );

  it('refuses a non-array', () => {
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: 'node server.js' as never }))).toBe('INVALID_INPUT');
  });
});

describe('entrypoint symlink handling', () => {
  beforeEach(() => {
    pkg();
  });

  it('rejects index.js -> a file outside the source (override)', () => {
    fs.symlinkSync(path.join(outside, 'secret.js'), path.join(dir, 'index.js'));
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'index.js'] }))).toBe('POLICY_VIOLATION');
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'index.js'] }))).toMatch(/outside the source/);
  });

  it('rejects the same symlink when it is a derived entry (package.json main, default index.js)', () => {
    fs.symlinkSync('/etc/passwd', path.join(dir, 'index.js'));
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('POLICY_VIOLATION');
    pkg({ main: 'index.js' });
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('POLICY_VIOLATION');
  });

  it('rejects a path through a symlinked directory that escapes', () => {
    fs.symlinkSync(outside, path.join(dir, 'lib'));
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'lib/secret.js'] }))).toBe('POLICY_VIOLATION');
    pkg({ main: 'lib/secret.js' });
    expect(codeOf(() => detectContainerRuntime(dir))).toBe('POLICY_VIOLATION');
  });

  it('rejects a symlink that stays inside the source, because symlinks are never copied', () => {
    write('real.js');
    fs.symlinkSync(path.join(dir, 'real.js'), path.join(dir, 'index.js'));
    const msg = messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'index.js'] }));
    expect(msg).toMatch(/symbolic link/);
    write('libreal/x.js');
    fs.symlinkSync(path.join(dir, 'libreal'), path.join(dir, 'liblink'));
    expect(codeOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'liblink/x.js'] }))).toBe('POLICY_VIOLATION');
  });

  it('treats a dangling symlink as missing, not as a file', () => {
    fs.symlinkSync(path.join(outside, 'does-not-exist.js'), path.join(dir, 'index.js'));
    expect(messageOf(() => detectContainerRuntime(dir, { entrypoint: ['node', 'index.js'] }))).toMatch(/does not exist/);
  });

  it('resolves a symlinked source directory itself', () => {
    write('index.js');
    const link = path.join(root, 'link-to-src');
    fs.symlinkSync(dir, link);
    const d = detectContainerRuntime(link);
    expect(d.sourceDir).toBe(dir);
    expect(d.entrypoint).toEqual(['node', 'index.js']);
  });
});

describe('name, version and base sanitisation', () => {
  it.each([
    ['My Cool Agent!', 'my-cool-agent'],
    ['@agentvault/examples/generic', 'agentvault-examples-generic'],
    ['UPPER_case-Name', 'upper_case-name'],
    ['--leading--', 'leading'],
    ['___x', 'x'],
    ['a'.repeat(60), 'a'.repeat(40)],
    ['x'.repeat(39) + '-yy', 'x'.repeat(39)],
    ['', 'agent'],
    ['!!!', 'agent'],
    ['日本語', 'agent'],
    ['demo\nRUN id', 'demo-run-id'],
    ['$(touch pwned)', 'touch-pwned'],
  ])('slugifies %j -> %j', (raw, expected) => {
    const slug = slugifyAgentName(raw);
    expect(slug).toBe(expected);
    expect(AGENT_NAME_RE.test(slug)).toBe(true);
  });

  it('slugifies non-strings to the fallback', () => {
    expect(slugifyAgentName(undefined)).toBe('agent');
    expect(slugifyAgentName({ toString: () => 'x' })).toBe('agent');
  });

  it.each([
    ['1.2.3', '1.2.3'],
    ['1.0.0-beta.1', '1.0.0-beta.1'],
    ['1.0.0+build.5', '1.0.0-build.5'],
    ['v2', 'v2'],
    ['  3.0 ', '3.0'],
    ['1.0\nRUN id', '1.0-RUN-id'],
    ['../../x', 'x'],
    ['', '0.0.0'],
    ['...', '0.0.0'],
    ['-1', '1'],
    ['x'.repeat(100), 'x'.repeat(64)],
  ])('sanitizes version %j -> %j', (raw, expected) => {
    expect(sanitizeVersion(raw)).toBe(expected);
  });

  it('falls back to 0.0.0 for non-string versions', () => {
    expect(sanitizeVersion(1)).toBe('0.0.0');
    expect(sanitizeVersion(null)).toBe('0.0.0');
    expect(sanitizeVersion({})).toBe('0.0.0');
  });

  it('takes the name from agent.json but slugifies it, and honours a name override', () => {
    write('agent.json', JSON.stringify({ name: 'My Agent\nRUN id', version: '2.0.0+x' }));
    write('index.js');
    pkg();
    const d = detectContainerRuntime(dir);
    expect(d.name).toBe('my-agent-run-id');
    expect(d.version).toBe('2.0.0-x');
    expect(detectContainerRuntime(dir, { name: 'Other One' }).name).toBe('other-one');
  });

  it('ignores a non-string agent.json version and falls back to package.json', () => {
    write('agent.json', JSON.stringify({ name: 'a', version: 7 }));
    write('index.js');
    pkg({ version: '4.5.6' });
    expect(detectContainerRuntime(dir).version).toBe('4.5.6');
  });

  it('accepts a valid base override and rejects hostile ones', () => {
    pkg();
    write('index.js');
    expect(detectContainerRuntime(dir, { base: 'node:20-slim' }).base).toBe('node:20-slim');
    expect(detectContainerRuntime(dir, { base: 'registry.example.com:5000/team/node:22@sha256:' + 'a'.repeat(64) }).base).toContain('@sha256:');
    for (const base of ['node:22\nRUN id', 'node:22 AS x', ' node', '-node', 'node;id', 'node$(id)', '']) {
      expect(codeOf(() => detectContainerRuntime(dir, { base }))).toBe('INVALID_INPUT');
    }
  });
});

describe('agent config files that are symlinks', () => {
  const HOST_JSON = '{"name":"leaked-host-name","version":"7.7.7"}';
  const HOST_YAML = 'name: leaked-host-name\nversion: 7.7.7\n';

  beforeEach(() => {
    pkg();
    write('index.js');
  });

  // These are every config file detectAgent() reads. It follows links and has no size cap,
  // so a link to a file outside the tree would choose the image's name and version.
  it.each([
    ['agent.json', HOST_JSON],
    ['agent.yaml', HOST_YAML],
    ['agent.yml', HOST_YAML],
    ['agentvault.json', HOST_JSON],
    ['goose.yaml', HOST_YAML],
    ['cline.json', HOST_JSON],
    ['clawdbot.json', HOST_JSON],
    ['polytician.json', HOST_JSON],
    ['nemoclaw.json', HOST_JSON],
  ])('ignores %s when it is a symlink, and says so', (name, content) => {
    fs.writeFileSync(path.join(outside, 'config'), content);
    fs.symlinkSync(path.join(outside, 'config'), path.join(dir, name));
    const d = detectContainerRuntime(dir);
    expect(d.name).toBe('agent-src');
    expect(d.version).toBe('1.0.0'); // package.json, not the link target
    expect(d.agentType).toBe('generic');
    const escaped = name.replace('.', '\\.');
    expect(d.warnings.join('\n')).toMatch(new RegExp(`${escaped} is a symbolic link and is ignored`));
    expect(JSON.stringify(d)).not.toContain('leaked-host-name');
  });

  it('ignores a dangling config symlink too', () => {
    fs.symlinkSync(path.join(outside, 'missing.json'), path.join(dir, 'agent.json'));
    const d = detectContainerRuntime(dir);
    expect(d.name).toBe('agent-src');
    expect(d.warnings.join('\n')).toMatch(/agent\.json is a symbolic link/);
  });

  it('still reads a regular config file', () => {
    write('agent.json', '{"name":"configured-name","version":"2.0.0"}');
    const d = detectContainerRuntime(dir);
    expect(d.name).toBe('configured-name');
    expect(d.version).toBe('2.0.0');
    expect(d.warnings.join('\n')).not.toMatch(/symbolic link/);
  });
});

describe('pip build-time risks', () => {
  const warningsFor = (): string => detectContainerRuntime(dir).warnings.join('\n');

  describe('requirements.txt', () => {
    beforeEach(() => write('main.py'));

    it.each([
      ['--index-url https://pypi.example/simple', '--index-url'],
      ['--index-url=https://pypi.example/simple', '--index-url'],
      ['-i https://pypi.example/simple', '-i'],
      ['--extra-index-url http://x', '--extra-index-url'],
      ['--trusted-host pypi.example', '--trusted-host'],
      ['--find-links ./wheels', '--find-links'],
      ['-f /wheels', '-f'],
      ['-e .', '-e'],
      ['--editable git+https://github.com/x/y.git#egg=y', '--editable'],
      ['-r /etc/passwd', '-r outside the source tree'],
      ['-r ../other.txt', '-r outside the source tree'],
      ['-rbase/../../x.txt', '-r outside the source tree'],
      ['--requirement=/abs/req.txt', '--requirement outside the source tree'],
      ['-c ../constraints.txt', '-c outside the source tree'],
      ['git+https://github.com/x/y.git#egg=y', 'URL'],
      ['pkg @ https://example.com/pkg.whl', 'URL'],
      ['https://example.com/pkg.tar.gz', 'URL'],
      ['file:///tmp/pkg.whl', 'URL'],
    ])('warns about "%s"', (line, label) => {
      write('requirements.txt', `requests==2.31.0\n${line}\n`);
      const warnings = warningsFor();
      expect(warnings).toContain('requirements.txt');
      expect(warnings).toContain('line 2');
      expect(warnings).toContain(label);
      expect(warnings).toMatch(/root/);
    });

    it('stays quiet about ordinary requirements, hashes, and a nested file inside the tree', () => {
      write(
        'requirements.txt',
        [
          '# a comment mentioning --index-url and git+https://x',
          'requests==2.31.0 --hash=sha256:' + 'a'.repeat(64),
          'numpy>=1.0 ; python_version > "3.8"  # inline --extra-index-url comment',
          '',
          '-r base.txt',
          '--no-binary :all:',
        ].join('\n')
      );
      expect(warningsFor()).not.toMatch(/requirements\.txt.*(line|pip option)/);
      expect(warningsFor()).not.toMatch(/root/);
    });

    it('reads a line continued with a backslash as one line', () => {
      write('requirements.txt', 'requests==2.31.0\n--index-url \\\n  https://pypi.example/simple\n');
      const warnings = warningsFor();
      expect(warnings).toContain('line 2');
      expect(warnings).toContain('--index-url');
    });

    it('lists every flagged line (up to a few) and never echoes a URL or a credential in it', () => {
      write(
        'requirements.txt',
        ['--index-url https://user:CANARY-pass@pypi.example/simple', '--extra-index-url http://x', '-e .', 'git+https://tok:CANARY-tok@github.com/x/y.git', '-f /w', '--trusted-host a', '--find-links b'].join('\n')
      );
      const warnings = warningsFor();
      expect(warnings).toContain('line 1');
      expect(warnings).toContain('line 2');
      expect(warnings).toMatch(/and 2 more/);
      expect(warnings).not.toContain('CANARY');
      expect(warnings).not.toContain('pypi.example');
    });

    it('does not read a symlinked requirements.txt', () => {
      fs.writeFileSync(path.join(outside, 'requirements.txt'), '--index-url http://evil\n');
      fs.symlinkSync(path.join(outside, 'requirements.txt'), path.join(dir, 'requirements.txt'));
      expect(warningsFor()).not.toContain('--index-url');
    });
  });

  describe('pyproject.toml', () => {
    beforeEach(() => write('main.py'));
    const project = (buildSystem: string): void => write('pyproject.toml', `[project]\nname = "demo"\nversion = "1.0"\n\n${buildSystem}\n`);

    it('warns about backend-path, which loads the build backend from the source tree', () => {
      project('[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n');
      const warnings = warningsFor();
      expect(warnings).toContain('backend-path');
      expect(warnings).toMatch(/root/);
    });

    it('warns about a build backend that is not a well-known one, and names it', () => {
      project('[build-system]\nrequires = ["evil-backend"]\nbuild-backend = "evil_backend.build"\n');
      const warnings = warningsFor();
      expect(warnings).toContain('"evil_backend.build"');
      expect(warnings).toMatch(/not a well-known/);
    });

    it('reads single-quoted values and ignores comments', () => {
      project("[build-system]\n# build-backend = \"setuptools.build_meta\"\nbuild-backend = 'sneaky.backend'  # not the line above\n");
      expect(warningsFor()).toContain('"sneaky.backend"');
    });

    it.each([
      'setuptools.build_meta',
      'setuptools.build_meta:__legacy__',
      'hatchling.build',
      'flit_core.buildapi',
      'poetry.core.masonry.api',
      'pdm.backend',
      'maturin',
      'mesonpy',
      'scikit_build_core.build',
    ])('stays quiet about the standard backend %s', (backend) => {
      project(`[build-system]\nrequires = ["x"]\nbuild-backend = "${backend}"\n`);
      expect(warningsFor()).not.toMatch(/build-backend|backend-path|not a well-known/);
    });

    it('stays quiet without a [build-system] table, or without a build-backend', () => {
      project('');
      expect(warningsFor()).not.toMatch(/build-backend|backend-path/);
      project('[build-system]\nrequires = ["setuptools"]\n');
      expect(warningsFor()).not.toMatch(/build-backend|backend-path/);
    });

    it('does not look at pyproject.toml when requirements.txt decides the install', () => {
      write('requirements.txt', 'requests==2.31.0\n');
      project('[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n');
      expect(warningsFor()).not.toContain('backend-path');
    });

    it('does not read a backend-path hiding in a different table', () => {
      project('[tool.other]\nbackend-path = ["."]\n');
      expect(warningsFor()).not.toContain('backend-path');
    });
  });
});

describe('exclusionReason', () => {
  it.each([
    '.env', '.env.local', '.env.production', '.ENV', '.git', 'node_modules', '.agentvault', '.venv', 'venv', '__pycache__',
    'server.pem', 'KEY.PEM', 'tls.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub',
    '.npmrc', '.pypirc', '.netrc', '.DS_Store', 'debug.log', '.ssh', '.aws', '.git-credentials',
  ])('excludes %s', (name) => {
    expect(exclusionReason(name)).toBeDefined();
  });

  it.each([
    // Environment-file variants: the docs promise ".env*", and "*.env" is the same kind of file.
    '.env~', '.env-prod', '.env_local', '.envs', '.envrc', '.environment', '.env_dir', 'prod.env', 'Staging.ENV',
    // Editor and backup decorations on a sensitive name.
    '.env.swp', '.env.local.orig', '.env.bak', 'prod.env.old', 'server.key.bak', 'server.pem~', 'tls.key.old', 'cert.p12.tmp',
    'id_rsa.bak', 'server.key.bak~', 'app.log.old',
    // Key and credential files the original list missed.
    'my_id_rsa', 'deploy-id_ed25519', 'key.p8', 'key.ppk', 'db.kdbx', 'secret.gpg', 'credentials.json', 'secrets', 'secrets.json',
    'secrets.yaml', 'secrets.py', 'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars', 'terraform.tfvars.json',
    'service-account.json', 'my-project-service-account-key.json', 'service_account.json', '.htpasswd', '.vault-token',
    'kubeconfig', 'prod.kubeconfig', '.boto', '.s3cfg', '.dockercfg', '.bash_history', '.zsh_history',
  ])('also excludes %s', (name) => {
    expect(exclusionReason(name)).toBeDefined();
  });

  it.each(['.env~', '.env-prod', '.env_local', '.envs', 'prod.env', '.env.swp'])('reports %s as an environment file (the CLI warns on that reason)', (name) => {
    expect(exclusionReason(name)).toMatch(/^environment file/);
  });

  it.each([
    'index.js', 'package.json', 'requirements.txt', 'main.py', 'src', 'dist', 'environment.js', 'key.txt', 'logger.js', 'Dockerfile',
    // Legitimate source that merely looks similar must still ship.
    'env', 'env.py', 'env.js', 'env.d.ts', 'environment.ts', 'dev.environment', 'dev.env.js', 'valid_rsa_key.js',
    'secrets_manager.js', 'secretsmanager.py', 'credentials.js', 'serviceaccount.js', 'service-account.ts', 'kubeconfig.js',
    'keyboard.js', 'monkey.js', 'notes.bak', 'config.old', 'readme.tmp', 'draft.swp', 'key.txt.bak', 'tfstate.js', 'app.log.js',
  ])('keeps %s', (name) => {
    expect(exclusionReason(name)).toBeUndefined();
  });
});
