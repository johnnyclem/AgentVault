import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Next 16 removed the `eslint` config key along with `next lint`; linting is
  // no longer part of `next build`, so there is nothing to opt out of.
  // @polkadot/* is excluded from bundling because its source contains
  // `proving${'\0'}`, which SWC's minifier folds into the template literal as
  // `proving\00` — an octal escape, which is illegal in template strings. The
  // resulting chunk throws SyntaxError at page-data collection and fails the
  // build. Loading these from node_modules at runtime sidesteps the minifier.
  serverExternalPackages: [
    '@dfinity/agent',
    '@dfinity/candid',
    '@dfinity/principal',
    'esbuild',
    '@polkadot/api',
    '@polkadot/keyring',
    '@polkadot/util',
    '@polkadot/util-crypto',
  ],
  webpack: (config: any) => {
    config.externals.push({
      'utf-8-validate': 'utf-8-validate',
      'buffer': 'buffer',
    });
    // The shared ../src tree uses NodeNext-style `.js` specifiers for
    // TypeScript files; teach webpack to resolve them like tsc does.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
