import React from 'react';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import Link from '@docusaurus/Link';

function Changelog(): JSX.Element {
  return (
    <Layout title="Changelog" description="AgentVault release notes and version history.">
      <main className="container margin-vert--xl">
        <Heading as="h1">Changelog</Heading>
        
        <div className="margin-top--lg">
          <Heading as="h2">v1.0.0 - February 2026</Heading>
          <p className="margin-bottom--md">
            Production-ready AI agent platform for the Internet Computer.
          </p>
          
          <Heading as="h3">Key Features</Heading>
          <ul>
            <li><strong>Production-Ready Platform</strong> - Complete web application for agent management</li>
            <li><strong>CLI with 37 commands</strong> - Full automation support</li>
            <li><strong>Agent Management</strong> - Package, deploy, monitor agents with WASM</li>
            <li><strong>Wallet System</strong> - Multi-chain support: ICP, Ethereum, Solana, Polkadot</li>
            <li><strong>Canister Operations</strong> - Deploy to local or production ICP with zero-downtime upgrades</li>
            <li><strong>Security</strong> - Multi-signature approvals, VetKeys integration, encrypted backups</li>
            <li><strong>Monitoring</strong> - Real-time metrics, health monitoring, alerting system</li>
            <li><strong>Archival</strong> - Arweave blockchain integration for permanent storage</li>
          </ul>
          
          <Heading as="h3">Installation</Heading>
          <div className="code-block">
            <pre>
              <code>npm install -g agentvault</code>
            </pre>
          </div>
          
          <Heading as="h3">Documentation</Heading>
          <ul>
            <li><Link to="/docs/getting-started/quick-start">Quick Start Guide</Link></li>
            <li><Link to="/docs/user/tutorial-v1.0">Comprehensive Tutorial</Link></li>
            <li><Link to="/docs/cli/reference">CLI Reference</Link></li>
            <li><Link to="/docs/dev/SECURITY_AUDIT">Security Audit</Link></li>
          </ul>
          
          <Heading as="h3">Breaking Changes</Heading>
          <p>None - This is the first stable release.</p>
          
          <Heading as="h3">Known Limitations</Heading>
          <ul>
            <li>Wallet crypto uses basic SHA-256 (not full elliptic curve support)</li>
            <li>VetKeys threshold signatures are simulated</li>
            <li>Bittensor inference requires API access</li>
            <li>Arweave archival requires wallet setup</li>
          </ul>
        </div>
        
        <div className="margin-top--xl">
          <Heading as="h3">Install v1.0.0</Heading>
          <div className="code-block">
            <pre>
              <code>npm install -g agentvault@1.0.0</code>
            </pre>
          </div>
          
          <div className="margin-top--lg">
            <Link
              className="button button--primary"
              to="https://github.com/johnnyclem/agentvault">
              View on GitHub
            </Link>
            <Link
              className="button button--secondary margin-left--sm"
              to="https://www.npmjs.com/package/agentvault">
              View on npm
            </Link>
          </div>
        </div>
      </main>
    </Layout>
  );
}

export default Changelog;
