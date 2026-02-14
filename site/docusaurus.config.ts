import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'AgentVault',
  tagline: 'Protecting the ghost within the machine through cryptographic decentralization.',
  favicon: 'img/favicon.ico',

  url: 'https://agentvault.cloud',
  baseUrl: '/',

  organizationName: 'johnnyclem',
  projectName: 'agentvault',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

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
    image: 'img/og-image.png',
    metadata: [
      {name: 'keywords', content: 'ICP, Internet Computer, AI agents, blockchain, canister, deployment, Web3'},
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'twitter:title', content: 'AgentVault // Neural Codex for Sovereign Agent Operations'},
      {name: 'twitter:description', content: 'Deploy autonomous AI entities to ICP canisters with sovereign execution, encrypted state, and resilient operations.'},
    ],
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'NEURAL_CODEX_V1',
      logo: {
        alt: 'AgentVault Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/security/overview',
          label: 'Protocols',
          position: 'left',
        },
        {
          to: '/docs/architecture/overview',
          label: 'Ecosystem',
          position: 'left',
        },
        {
          href: 'https://github.com/johnnyclem/agentvault',
          label: 'Connect Soul',
          className: 'navbar-connect-soul',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
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
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AgentVault // Documentation Engine`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json', 'yaml', 'markdown'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
