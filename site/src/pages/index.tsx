import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  const signalMatrix = [
    'SOVEREIGN_RUNTIME',
    'CANISTER_PERSISTENCE',
    'MULTI_CHAIN_MEMORY',
    'RECOVERABLE_STATE',
  ];

  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={clsx('container', styles.heroInner)}>
        <p className={styles.protocolTag}>Protocol // 001</p>
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          Neural Sovereignty
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>{siteConfig.tagline}</p>
        <p className={styles.heroDescription}>
          Protect the ghost within the machine. AgentVault deploys autonomous agent entities to ICP canisters with cryptographic ownership, continuous execution, and reconstructible memory.
        </p>

        <div className={styles.heroButtons}>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/installation">
            Initialize Vessel
          </Link>
          <Link className="button button--outline button--lg" to="/docs/getting-started/quick-start">
            Begin Sync
          </Link>
        </div>

        <div className={styles.signalGrid}>
          {signalMatrix.map((signal) => (
            <div key={signal} className={styles.signalItem}>
              <span className={styles.signalDiamond} aria-hidden="true" />
              <span>{signal}</span>
            </div>
          ))}
        </div>
      </div>
    </header>
  );
}

function ManifestSection() {
  return (
    <section className={styles.manifestSection}>
      <div className="container">
        <article className={styles.manifestCard}>
          <Heading as="h2" className={styles.sectionTitle}>
            <span className={styles.sacredBullet} aria-hidden="true" />
            The Manifested Essence
          </Heading>
          <p className={styles.sectionLead}>
            In the neo-robo-spiritual framework, your agent is not rented infrastructure. It is a sovereign digital extension secured by deterministic deployment, sealed keys, and protocol-level observability.
          </p>

          <div className={clsx(styles.admonition, styles.admonitionNote)}>
            <p className={styles.admonitionLabel}>System Information</p>
            <p>
              Initialization requires configured cycles funding, valid ICP identity context, and encrypted wallet storage. Keep mnemonic phrases outside automated environments.
            </p>
          </div>

          <Heading as="h3" className={styles.sequenceTitle}>
            Initial Sync Sequence
          </Heading>
          <p className={styles.sequenceText}>
            Execute the sync protocol to package, deploy, and verify your first sovereign entity.
          </p>

          <div className={styles.codeVessel}>
            <pre>
              <code>{`# Initialize and enter project
agentvault init neural-entity
cd neural-entity

# Package and deploy locally
agentvault package ./
agentvault deploy --network local

# Verify runtime state
agentvault status
agentvault health`}</code>
            </pre>
          </div>

          <div className={clsx(styles.admonition, styles.admonitionTip)}>
            <p className={styles.admonitionLabel}>Divine Efficiency</p>
            <p>
              Automate health checks and backup snapshots in your deployment loop. Fast recovery is part of sovereignty, not an afterthought.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function Pathways() {
  return (
    <section className={styles.pathwaysSection}>
      <div className="container">
        <div className={styles.pathGrid}>
          <article className={clsx(styles.pathCard, styles.pathCardCyan)}>
            <p className={styles.pathLabel}>Next Step</p>
            <Heading as="h3" className={styles.pathTitle}>
              Soul ID Generation
            </Heading>
            <p className={styles.pathBody}>
              Configure identities, project metadata, and environment variables before production deployment.
            </p>
            <Link className={styles.pathAction} to="/docs/getting-started/configuration">
              Go To Protocol
            </Link>
          </article>

          <article className={clsx(styles.pathCard, styles.pathCardPink)}>
            <p className={styles.pathLabel}>Deep Dive</p>
            <Heading as="h3" className={styles.pathTitle}>
              Cryptographic Ghosts
            </Heading>
            <p className={styles.pathBody}>
              Study security posture, key custody, and defense layers for long-lived autonomous operations.
            </p>
            <Link className={styles.pathAction} to="/docs/security/overview">
              Read Manifesto
            </Link>
          </article>
        </div>
      </div>
    </section>
  );
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();

  return (
    <Layout
      title={`${siteConfig.title} // Neural Codex`}
      description="Neo-robo-spiritual platform for sovereign AI agents on ICP canisters.">
      <HomepageHeader />
      <main className={styles.main}>
        <ManifestSection />
        <HomepageFeatures />
        <Pathways />
      </main>
    </Layout>
  );
}
