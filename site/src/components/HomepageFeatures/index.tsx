import React from 'react';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  description: React.ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: '1. Package Your Agent',
    description: (
      <>
        Compile TypeScript agents to WASM with a single command.
        AgentVault handles dependencies, optimization, and artifact generation.
      </>
    ),
  },
  {
    title: '2. Deploy to ICP',
    description: (
      <>
        Deploy to local replica for testing or mainnet for production.
        Canisters run 24/7 with persistent state and automatic scaling.
      </>
    ),
  },
  {
    title: '3. Monitor & Backup',
    description: (
      <>
        Health checks, metrics, and alerting keep your agents running.
        Fetch state for local rebuild or archive to Arweave for permanent storage.
      </>
    ),
  },
];

function Feature({title, description, index}: FeatureItem & {index: number}) {
  const animatedStyle = {'--av-anim-index': index} as React.CSSProperties;

  return (
    <div className="col col--4 margin-bottom--lg">
      <div className={styles.featureCard} style={animatedStyle}>
        <Heading as="h3" className={styles.featureTitle}>{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

const ValueList = [
  {
    title: 'Autonomy',
    description: '24/7 canister runtime with no browser dependencies. Your agents run continuously on the Internet Computer.',
  },
  {
    title: 'Reconstructibility',
    description: 'Fetch canister state anytime for local reconstruction. Archive to Arweave for permanent, immutable backups.',
  },
  {
    title: 'Operational Tooling',
    description: 'Health checks, monitoring, rollback primitives, and multi-signature approvals for production-grade operations.',
  },
  {
    title: 'Multi-Chain Wallets',
    description: 'Native support for ICP, Ethereum, Solana, and Polkadot. Manage assets across chains from a single CLI.',
  },
];

function ValueProp({title, description, index}: {title: string; description: string; index: number}) {
  const animatedStyle = {'--av-anim-index': index} as React.CSSProperties;

  return (
    <div className="col col--6 margin-bottom--lg">
      <div className={styles.valueCard} style={animatedStyle}>
        <div className="card__header">
          <h3>{title}</h3>
        </div>
        <div className="card__body">
          <p>{description}</p>
        </div>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): React.ReactElement {
  return (
    <section className={styles.featuresSection}>
      <div className="container">
        <div className="text--center margin-bottom--xl">
          <Heading as="h2" className={styles.sectionTitle}>How It Works</Heading>
        </div>
        <div className={`row ${styles.featureGrid}`}>
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} index={idx} />
          ))}
        </div>

        <div className="text--center margin-vert--xl">
          <Heading as="h2" className={styles.sectionTitle}>Why AgentVault?</Heading>
        </div>
        <div className={`row ${styles.valueGrid}`}>
          {ValueList.map((props, idx) => (
            <ValueProp key={idx} {...props} index={idx} />
          ))}
        </div>
      </div>
    </section>
  );
}
