// A deliberately tiny agent for `agentvault package --target container`.
//
//  1. It keeps a note log in /data, the agent's persistent volume, so you can see
//     that state survives `agentvault stop` / `run` (and snapshots).
//  2. If a model API is configured it asks one question. It never holds a real key:
//     ANTHROPIC_BASE_URL points at the credential proxy and ANTHROPIC_API_KEY is
//     only a placeholder; the proxy attaches the real key on the way out.
//
// No dependencies: it uses Node 22's built-in fetch.

import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const NOTES = '/data/notes.log';

function remember(line) {
  appendFileSync(NOTES, `${new Date().toISOString()} ${line}\n`);
  return readFileSync(NOTES, 'utf8').trimEnd().split('\n').length;
}

async function askModel() {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return 'no model configured (run with --service anthropic to enable one)';
  const model = process.env.MODEL ?? 'claude-haiku-5-5';
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'In five words, say hello to a freshly started container.' }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return `model call failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`;
    return body.content?.[0]?.text ?? '(empty reply)';
  } catch (error) {
    return `model call failed: ${error.cause?.code ?? error.name}`;
  }
}

const previous = existsSync(NOTES) ? readFileSync(NOTES, 'utf8').trimEnd().split('\n').filter(Boolean).length : 0;
const total = remember(`start #${previous + 1} as uid ${process.getuid()}`);
console.log(`notes: this is start #${previous + 1}; ${total} line(s) in ${NOTES}`);
console.log(`model: ${await askModel()}`);
console.log('idle: waiting to be stopped (agentvault stop <agent>)');
setInterval(() => {}, 60_000);
