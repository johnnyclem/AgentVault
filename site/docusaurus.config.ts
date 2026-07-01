import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'AgentVault',
  tagline: 'Deploy AI agents that run forever.',
  favicon: 'img/logo.svg',

  url: 'https://agentvault.cloud',
  baseUrl: '/',

  organizationName: 'johnnyclem',
  projectName: 'agentvault',

  onBrokenLinks: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/johnnyclem/agentvault/tree/main/site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/og-image.svg',
    metadata: [
      {name: 'keywords', content: 'ICP, Internet Computer, AI agents, blockchain, canister, deployment, Web3'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:title', content: 'AgentVault — Production infrastructure for autonomous AI agents'},
      {name: 'twitter:description', content: 'Deploy AI agents to ICP canisters with a durable identity, multi-chain wallet, encrypted secrets, and versioned memory.'},
    ],
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'AgentVault',
      logo: {
        alt: 'AgentVault Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          to: '/docs',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/security/overview',
          label: 'Security',
          position: 'left',
        },
        {
          to: '/docs/ecosystem/executive-summary',
          label: 'Ecosystem',
          position: 'left',
        },
        {
          to: '/changelog',
          label: 'Changelog',
          position: 'left',
        },
        {
          href: 'https://github.com/johnnyclem/agentvault',
          label: 'GitHub',
          className: 'navbar-github-mobile',
          position: 'left',
        },
        {
          href: 'https://github.com/johnnyclem/agentvault',
          label: 'GitHub',
          className: 'navbar-github-desktop',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Getting Started',
              to: '/docs/getting-started/quick-start',
            },
            {
              label: 'CLI Reference',
              to: '/docs/cli/reference',
            },
            {
              label: 'Architecture',
              to: '/docs/architecture/overview',
            },
            {
              label: 'Ecosystem',
              to: '/docs/ecosystem/executive-summary',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Issues',
              href: 'https://github.com/johnnyclem/agentvault/issues',
            },
            {
              label: 'ICP Forum',
              href: 'https://forum.dfinity.org/',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/johnnyclem/agentvault',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/agentvault',
            },
            {
              label: 'Changelog',
              to: '/changelog',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AgentVault.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json', 'yaml', 'markdown'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
