import type {PrismTheme} from 'prism-react-renderer';

/*
 * Code colours for the paper and ink palette: blue ink for keywords and flags,
 * moss for strings, ochre for numbers and variables, everything else in the
 * text ramp. Nothing is italic. Every colour clears 4.5:1 on the code surface
 * (--av-raised), including under a highlighted line.
 *
 * Light surface #efe9df, dark surface #262421 (see custom.css).
 */
type Palette = {
  background: string;
  text: string;
  comment: string;
  punctuation: string;
  keyword: string;
  property: string;
  string: string;
  number: string;
  negative: string;
};

function buildTheme(c: Palette): PrismTheme {
  const normal = {fontStyle: 'normal' as const};

  return {
    plain: {
      color: c.text,
      backgroundColor: c.background,
    },
    styles: [
      {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: c.comment, ...normal}},
      {types: ['namespace'], style: {color: c.punctuation, ...normal}},
      {types: ['punctuation', 'operator', 'entity', 'url'], style: {color: c.punctuation, ...normal}},
      {types: ['function', 'class-name'], style: {color: c.text, ...normal}},
      {types: ['number', 'boolean', 'constant', 'symbol', 'variable', 'regex'], style: {color: c.number, ...normal}},
      {types: ['string', 'char', 'attr-value', 'inserted', 'template-string'], style: {color: c.string, ...normal}},
      {types: ['property'], style: {color: c.property, ...normal}},
      // Tokens can carry two types, like a flag that is also a variable. These come last so the flag stays blue.
      {
        types: ['keyword', 'atrule', 'tag', 'selector', 'builtin', 'important', 'parameter', 'attr-name'],
        style: {color: c.keyword, ...normal},
      },
      {types: ['deleted'], style: {color: c.negative, ...normal}},
      {types: ['italic'], style: normal},
    ],
  };
}

export const lightTheme = buildTheme({
  background: '#efe9df',
  text: '#1f1b16',
  comment: '#675e52',
  punctuation: '#5e554a',
  keyword: '#1d4ed8',
  property: '#1e40af',
  string: '#3f6212',
  number: '#92400e',
  negative: '#b91c1c',
});

export const darkTheme = buildTheme({
  background: '#262421',
  text: '#efe9de',
  comment: '#a09a90',
  punctuation: '#aaa398',
  keyword: '#60a5fa',
  property: '#93c5fd',
  string: '#b5cf8a',
  number: '#e0b070',
  negative: '#f87171',
});
