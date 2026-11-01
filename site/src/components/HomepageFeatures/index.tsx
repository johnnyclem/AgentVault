import React from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import {ArrowRightIcon} from '@site/src/components/Icons';
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
    description: 'Compile local agent code to WASM and generate the artifacts you deploy.',
    destination: '/docs/getting-started/quick-start',
    action: 'View the workflow',
  },
  {
    id: '02',
    title: 'Deploy to a canister',
    description:
      'Ship to a local replica or ICP mainnet. Upgrade an existing canister, and list an agent’s deployment history.',
    destination: '/docs/user/deployment',
    action: 'Open deployment docs',
  },
  {
    id: '03',
    title: 'Keep it recoverable',
    description:
      'Run health checks, roll a deployment back, and export an encrypted backup you can restore to a fresh canister.',
    destination: '/docs/user/backups',
    action: 'Open the backup guide',
  },
];

const PlatformCapabilities: FeatureItem[] = [
  {
    id: 'wallets',
    title: 'Multi-chain wallets',
    description:
      'Keep ICP, ckETH, Solana, Polkadot and Arweave wallets in one CLI, with encrypted local key custody. ckETH, Solana and Polkadot transfers can be signed; ICP and Arweave signing is not implemented yet.',
    destination: '/docs/user/wallets',
    action: 'Explore wallets',
  },
  {
    id: 'security',
    title: 'Security controls',
    description:
      'Approval requests with a signer quorum and an optional TOTP check, both tracked locally (they do not block deploys and are not cryptographic multisig), plus canister write guards: authorized principals, freeze and kill switches.',
    destination: '/docs/security/overview',
    action: 'Review security',
  },
  {
    id: 'operations',
    title: 'Operations tooling',
    description: 'Monitoring, promotion, rollback, and task visibility for managing long-lived agents.',
    destination: '/docs/guides/monitoring',
    action: 'Open monitoring',
  },
  {
    id: 'architecture',
    title: 'Architecture',
    description:
      'Understand canister internals, module boundaries, and ICP integration primitives before you scale out.',
    destination: '/docs/architecture/overview',
    action: 'Read the architecture',
  },
];

function FeatureAction({destination, action}: Pick<FeatureItem, 'destination' | 'action'>) {
  return (
    <Link className="av-link" to={destination}>
      {action}
      <ArrowRightIcon />
    </Link>
  );
}

export default function HomepageFeatures(): React.ReactElement {
  return (
    <section className={styles.featuresSection}>
      <div className="av-wrap">
        <div className="av-sectionHead">
          <p className="av-label">How it works</p>
          <Heading as="h2" className="av-h2">
            Package, deploy, recover
          </Heading>
        </div>

        <ol className={styles.steps}>
          {CoreWorkflow.map((item) => (
            <li key={item.id} className={styles.step}>
              <p className={styles.stepId}>{item.id}</p>
              <Heading as="h3" className={styles.itemTitle}>
                {item.title}
              </Heading>
              <p className={styles.itemBody}>{item.description}</p>
              <FeatureAction destination={item.destination} action={item.action} />
            </li>
          ))}
        </ol>

        <div className={styles.platformHead}>
          <div className="av-sectionHead">
            <Heading as="h2" className="av-h2">
              What the platform includes
            </Heading>
          </div>
        </div>

        <ul className={styles.capabilities}>
          {PlatformCapabilities.map((item) => (
            <li key={item.id} className={styles.capability}>
              <Heading as="h3" className={styles.itemTitle}>
                {item.title}
              </Heading>
              <p className={styles.itemBody}>{item.description}</p>
              <FeatureAction destination={item.destination} action={item.action} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
