import React from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';
import {ArrowUpRightIcon} from '@site/src/components/Icons';

import styles from './changelog.module.css';

/*
 * Facts here come from the product repo: the v1.0.0 entry of CHANGELOG.md,
 * the README's Known Limitations table and LICENSE. The release date and the
 * command count are left out on purpose: CHANGELOG.md dates 1.0.0 as
 * 2025-02-12, git history says February 2026, and the CLI has grown since.
 */
const releaseFeatures = [
  'Agent packaging, deployment, and lifecycle operations.',
  'A command line for automation, diagnostics, and maintenance.',
  'Multi-chain wallet operations for ICP, Ethereum, Solana, and Polkadot.',
  'Security controls with locally tracked approval quorums and encrypted backups.',
  'Monitoring, promotion, rollback, and archival workflows.',
];

const knownLimitations = [
  'ICP and Arweave transaction signing is not implemented in wallet sign.',
  'VetKeys threshold signatures are not implemented.',
  'Bittensor inference integrations require external API credentials.',
  'Arweave archival requires operator wallet setup and funding.',
];

function Changelog(): React.ReactElement {
  return (
    <Layout title="Changelog" description="AgentVault release history and version notes.">
      <main className={styles.main}>
        <div className="av-wrap">
          <header className={styles.header}>
            <p className="av-label">Release history</p>
            <Heading as="h1" className={styles.pageTitle}>
              Changelog
            </Heading>
            <p className="av-lead">Release history for the AgentVault runtime, starting with v1.0.0.</p>
          </header>

          <section className={styles.release}>
            <div className={styles.releaseHead}>
              <div>
                <Heading as="h2" className={styles.releaseTitle}>
                  v1.0.0, the first stable release
                </Heading>
                <p className={styles.releaseSubtitle}>
                  The first stable release for continuous on-chain agent operations.
                </p>
              </div>
              <dl className={clsx('av-manifest', styles.manifest)}>
                <div className="av-manifestRow">
                  <dt className="av-manifestKey">Release</dt>
                  <dd className="av-manifestValue">v1.0.0</dd>
                </div>
                <div className="av-manifestRow">
                  <dt className="av-manifestKey">Package</dt>
                  <dd className="av-manifestValue">agentvault on npm</dd>
                </div>
                <div className="av-manifestRow">
                  <dt className="av-manifestKey">License</dt>
                  <dd className="av-manifestValue">MIT</dd>
                </div>
              </dl>
            </div>

            <div className={styles.releaseBody}>
              <section className={styles.block}>
                <Heading as="h3" className={styles.subTitle}>
                  What's included
                </Heading>
                <ul className={styles.itemList}>
                  {releaseFeatures.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>

              <section className={styles.block}>
                <Heading as="h3" className={styles.subTitle}>
                  Install
                </Heading>
                <div className={styles.codeVessel}>
                  <pre>
                    <code>npm install -g agentvault@1.0.0</code>
                  </pre>
                </div>
              </section>

              <section className={styles.block}>
                <Heading as="h3" className={styles.subTitle}>
                  Related reading
                </Heading>
                <ul className={styles.linkList}>
                  <li>
                    <Link to="/docs/getting-started/quick-start">Quick start</Link>
                  </li>
                  <li>
                    <Link to="/docs/user/tutorial-v1.0">Tutorial</Link>
                  </li>
                  <li>
                    <Link to="/docs/cli/reference">CLI reference</Link>
                  </li>
                  <li>
                    <Link to="/docs/dev/SECURITY_AUDIT">Security audit</Link>
                  </li>
                </ul>
              </section>

              <section className={styles.block}>
                <Heading as="h3" className={styles.subTitle}>
                  Known limitations
                </Heading>
                <ul className={styles.itemList}>
                  {knownLimitations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            </div>
          </section>

          <section className={styles.actions}>
            <Link className="button button--secondary" to="https://github.com/johnnyclem/agentvault">
              View source
            </Link>
            <Link className="button button--outline" to="https://www.npmjs.com/package/agentvault">
              View package
              <ArrowUpRightIcon className={styles.actionIcon} />
            </Link>
          </section>
        </div>
      </main>
    </Layout>
  );
}

export default Changelog;
