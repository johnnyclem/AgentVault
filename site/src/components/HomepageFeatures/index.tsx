import React from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  id: string;
  title: string;
  description: string;
  destination: string;
  action: string;
};

const CoreWorkflow: FeatureItem[] = [
  {
    id: '01',
    title: 'Package your agent',
    description:
      'Compile local agent code into reproducible WASM artifacts with built-in integrity checks — no manual build pipeline required.',
    destination: '/docs/getting-started/quick-start',
    action: 'View the workflow',
  },
  {
    id: '02',
    title: 'Deploy anywhere',
    description:
      'Ship to a local replica or ICP mainnet with controlled upgrades, environment targeting, and full deployment history.',
    destination: '/docs/user/deployment',
    action: 'Open deployment docs',
  },
  {
    id: '03',
    title: 'Keep it recoverable',
    description:
      'Run health checks, rollback gates, and automated backups so agent state is always recoverable, even under pressure.',
    destination: '/docs/user/backups',
    action: 'Open the backup guide',
  },
];

const PlatformCapabilities: FeatureItem[] = [
  {
    id: 'A1',
    title: 'Multi-chain wallets',
    description:
      'Operate ICP, Ethereum, Solana, and Polkadot assets from a single CLI, with encrypted local key custody.',
    destination: '/docs/user/wallets',
    action: 'Explore wallets',
  },
  {
    id: 'A2',
    title: 'Security by default',
    description:
      'Multi-signature approvals, MFA gating, and canister-level hardening are built in, not bolted on.',
    destination: '/docs/security/overview',
    action: 'Review security',
  },
  {
    id: 'A3',
    title: 'Operations tooling',
    description:
      'Monitoring, promotion, rollback, and task visibility for managing long-lived agents without guesswork.',
    destination: '/docs/guides/monitoring',
    action: 'Open monitoring',
  },
  {
    id: 'A4',
    title: 'Clear architecture',
    description:
      'Understand canister internals, module boundaries, and ICP integration primitives before you scale out.',
    destination: '/docs/architecture/overview',
    action: 'Read the architecture',
  },
];

function FeatureCard({id, title, description, destination, action}: FeatureItem) {
  return (
    <article className={styles.featureCard}>
      <p className={styles.cardId}>{id}</p>
      <Heading as="h3" className={styles.cardTitle}>
        {title}
      </Heading>
      <p className={styles.cardBody}>{description}</p>
      <Link className={styles.cardAction} to={destination}>
        {action} →
      </Link>
    </article>
  );
}

export default function HomepageFeatures(): React.ReactElement {
  return (
    <section className={styles.featuresSection}>
      <div className="container">
        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>How it works</p>
          <Heading as="h2" className={styles.blockTitle}>
            Everything you need to run agents in production
          </Heading>
        </div>

        <div className={styles.featureGrid}>
          {CoreWorkflow.map((item) => (
            <FeatureCard key={item.id} {...item} />
          ))}
        </div>

        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>Platform</p>
          <Heading as="h2" className={styles.blockTitle}>
            Built for reliability, not demos
          </Heading>
        </div>

        <div className={styles.protocolGrid}>
          {PlatformCapabilities.map((item) => (
            <FeatureCard key={item.id} {...item} />
          ))}
        </div>
      </div>
    </section>
  );
}
