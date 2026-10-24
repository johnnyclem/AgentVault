import { describe, it, expect } from 'vitest';
import { prettyPath, renderCard, shortenMiddle, stripAnsi, visibleWidth, wrapText } from '../../src/total-recall/onboard-ui.js';

describe('onboard-ui', () => {
  it('measures what is visible, not the colour codes', () => {
    expect(visibleWidth('\u001b[36mabc\u001b[39m')).toBe(3);
    expect(stripAnsi('\u001b[1m\u001b[32mgo\u001b[0m')).toBe('go');
  });

  it('draws a card whose every line is the same width, coloured rows included', () => {
    const lines = renderCard('Ready', ['plain row', '\u001b[1mbold\u001b[22m row that is a bit longer than the rest of them'], { minWidth: 30 });
    const widths = lines.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(lines[0]).toMatch(/^╭─ Ready ─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
    expect(lines).toHaveLength(4);
    // the title is never wider than the card
    expect(renderCard('A rather long title for a short card', ['x'], { minWidth: 10 }).map(visibleWidth)).toSatisfy((w: number[]) => new Set(w).size === 1);
  });

  it('shortens the middle of long strings and shows paths the way a person says them', () => {
    expect(shortenMiddle('short', 20)).toBe('short');
    const long = '/very/long/path/to/some/deeply/nested/archive/folder';
    const short = shortenMiddle(long, 24);
    expect(Array.from(short)).toHaveLength(24);
    expect(short).toContain('…');
    expect(short.startsWith('/very/long')).toBe(true);
    expect(short.endsWith('folder')).toBe(true);

    expect(prettyPath('/home/me/proj/.agentvault/total-recall', { cwd: '/home/me/proj', home: '/home/me' })).toBe('./.agentvault/total-recall');
    expect(prettyPath('/home/me/.agentvault/total-recall', { cwd: '/srv/other', home: '/home/me' })).toBe('~/.agentvault/total-recall');
    expect(prettyPath('/opt/x', { cwd: '/home/me', home: '/home/me' })).toBe('/opt/x');
    expect(prettyPath('/home/me', { cwd: '/srv', home: '/home/me' })).toBe('~');
  });

  it('wraps text to a width without splitting words, keeping paragraph breaks', () => {
    expect(wrapText('one two three four five', 9)).toEqual(['one two', 'three', 'four five']);
    expect(wrapText('a b\n\nc', 10)).toEqual(['a b', '', 'c']);
  });
});
