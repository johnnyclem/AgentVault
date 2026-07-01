import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Introduction',
    },
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/installation',
        'getting-started/quick-start',
        'getting-started/configuration',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'user/tutorial-v1.0',
        'user/deployment',
        'user/wallets',
        'user/backups',
        'user/webapp',
        'user/troubleshooting',
        'user/clawdbot-claude-skill',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      items: [
        'cli/reference',
        'cli/options',
      ],
    },
    {
      type: 'category',
      label: 'Security',
      items: [
        'security/overview',
        'security/best-practices',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/overview',
        'architecture/modules',
        'architecture/canister',
      ],
    },
    {
      type: 'category',
      label: 'Ecosystem',
      items: [
        'ecosystem/executive-summary',
        'ecosystem/engineering-guide',
      ],
    },
    {
      type: 'category',
      label: 'Contributing',
      items: [
        'development/contributing',
        'development/testing',
      ],
    },
    {
      type: 'category',
      label: 'Advanced',
      items: [
        'guides/monitoring',
        'guides/advanced/promotion',
        'guides/advanced/rollback',
      ],
    },
    {
      type: 'category',
      label: 'Archive',
      items: [
        'dev/SECURITY_AUDIT',
        'marketing/release-notes',
        'PRD',
      ],
    },
  ],
};

export default sidebars;
