import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={styles.heroGrid} aria-hidden="true" />
      <div className={clsx('container', styles.heroInner)}>
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          {siteConfig.title}
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>{siteConfig.tagline}</p>
        <p className={styles.heroDescription}>
          AgentVault packages local agents, deploys to ICP canisters, and preserves
          reconstructible state for resilient automation.
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/getting-started/installation">
            Install AgentVault
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/docs/user/tutorial-v1.0">
            Read Tutorial
          </Link>
        </div>
      </div>
    </header>
  );
}

function TrustBar() {
  const trustItems = [
    {icon: '📦', label: 'Open Source'},
    {icon: '🌐', label: 'Built on ICP'},
    {icon: '⛓️', label: 'Multi-Chain'},
    {icon: '💾', label: 'Backup & Rebuild'},
    {icon: '✅', label: '508 Tests'},
  ];

  return (
    <div className={styles.trustBar}>
      <div className="container">
        <div className={styles.trustItems}>
          {trustItems.map((item, idx) => (
            <div
              key={item.label}
              className={styles.trustItem}
              style={{'--av-item-index': idx} as React.CSSProperties}>
              <span className={styles.trustIcon}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function QuickInstall() {
  return (
    <section className={styles.quickInstall}>
      <div className="container">
        <h2>Quick Install</h2>
        <div className={styles.codeBlock}>
          <code>npm install -g agentvault</code>
        </div>
        <p className={styles.quickStart}>
          Then run <code>agentvault init my-agent</code> to create your first project.
        </p>
      </div>
    </section>
  );
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} - Persistent On-Chain AI Agents`}
      description="Deploy autonomous AI agents to ICP canisters for persistent, 24/7 execution without browser dependencies.">
      <HomepageHeader />
      <TrustBar />
      <main className={styles.main}>
        <HomepageFeatures />
        <QuickInstall />
      </main>
    </Layout>
  );
}
