/**
 * Total Recall — onboarding presentation helpers
 *
 * Pure string functions the wizard draws with, kept apart from the prompts
 * so they can be tested. They know about ANSI colour (a styled string's
 * visible width is what counts) and nothing about chalk or inquirer.
 */

import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Visible width of a string once colour codes are removed. */
export function visibleWidth(text: string): number {
  return Array.from(stripAnsi(text)).length;
}

/** Shorten the middle of a long string: `/very/long/…/path/file`. */
export function shortenMiddle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 8) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}

/** A path as a person would say it: relative to here when that's shorter, `~/` under home, never over `max` wide. */
export function prettyPath(target: string, options: { cwd?: string; home?: string; max?: number } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const abs = path.resolve(target);
  const candidates = [abs];
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) candidates.push(`.${path.sep}${rel}`);
  if (abs === home) candidates.push('~');
  else if (abs.startsWith(home + path.sep)) candidates.push(`~${abs.slice(home.length)}`);
  const best = candidates.reduce((a, b) => (b.length < a.length ? b : a));
  return shortenMiddle(best, options.max ?? 64);
}

/**
 * A rounded card:
 *
 *   ╭─ Title ───────────────╮
 *   │ row                   │
 *   ╰───────────────────────╯
 *
 * `style` colours the frame (default: none). Rows may carry colour codes.
 */
export function renderCard(
  title: string,
  rows: string[],
  options: { minWidth?: number; style?: (s: string) => string } = {},
): string[] {
  const style = options.style ?? ((s: string) => s);
  const inner = Math.max(options.minWidth ?? 44, visibleWidth(title) + 4, ...rows.map((r) => visibleWidth(r) + 2));
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, inner - visibleWidth(title) - 3))}╮`;
  const body = rows.map((row) => `${style('│')} ${row}${' '.repeat(Math.max(0, inner - visibleWidth(row) - 1))}${style('│')}`);
  const bottom = `╰${'─'.repeat(inner)}╯`;
  return [style(top), ...body, style(bottom)];
}

/** Word-wrap plain text to `width` columns. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out;
}
