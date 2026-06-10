import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: ['@dfinity/agent', '@dfinity/candid', '@dfinity/principal', 'esbuild'],
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
