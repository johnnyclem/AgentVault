#!/usr/bin/env node
/**
 * Dev dashboard launcher: runs the core watcher and the webapp dev server
 * together (`npm run dev:dashboard`), prefixing each process's output.
 */

import { spawn } from 'node:child_process';

const processes = [
  { name: 'core', color: '\x1b[36m', args: ['run', 'dev:core'] },
  { name: 'webapp', color: '\x1b[35m', args: ['--prefix', 'webapp', 'run', 'dev'] },
];

const reset = '\x1b[0m';
const children = [];
let shuttingDown = false;

function prefixPipe(stream, name, color, out) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      out.write(`${color}[${name}]${reset} ${line}\n`);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const { name, color, args } of processes) {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  prefixPipe(child.stdout, name, color, process.stdout);
  prefixPipe(child.stderr, name, color, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`${color}[${name}]${reset} exited with code ${code ?? 0}; stopping dev dashboard`);
      shutdown(code ?? 0);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
