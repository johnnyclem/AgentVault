import React, {useMemo, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import styles from './index.module.css';

type WalletId = 'ethereum' | 'icp' | 'arweave';
type InstallChannel = 'npx' | 'global';
type ProjectTemplate = 'default' | 'minimal';
type DeployNetwork = 'local' | 'ic';
type SnapshotProfileId = 'clawdbot' | 'coding-cli' | 'goose' | 'ide-agent' | 'custom';

type WalletConnection = {
  address: string;
  chainName: string;
  type: WalletId;
};

type WalletOption = {
  id: WalletId;
  name: string;
  chainName: string;
  installUrl: string;
  installLabel: string;
  isAvailable: () => boolean;
  connect: () => Promise<WalletConnection>;
};

type SnapshotProfile = {
  id: SnapshotProfileId;
  name: string;
  description: string;
  defaultPath: string;
  snapshotTarget: string;
  restoreTarget: string;
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: {method: string; params?: unknown[]}) => Promise<unknown>;
    };
    ic?: {
      plug?: {
        requestConnect: (args?: {whitelist?: string[]; host?: string}) => Promise<boolean>;
        agent?: {
          getPrincipal?: () => Promise<{toText: () => string}>;
        };
      };
    };
    arweaveWallet?: {
      connect: (permissions: string[]) => Promise<void>;
      getActiveAddress: () => Promise<string>;
    };
  }
}

const walletOptions: WalletOption[] = [
  {
    id: 'ethereum',
    name: 'MetaMask',
    chainName: 'Ethereum',
    installUrl: 'https://metamask.io/download/',
    installLabel: 'Install MetaMask',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.ethereum),
    connect: async () => {
      if (typeof window === 'undefined' || !window.ethereum) {
        throw new Error('MetaMask was not detected in this browser.');
      }

      const accounts = (await window.ethereum.request({method: 'eth_requestAccounts'})) as string[];
      if (!accounts || accounts.length === 0) {
        throw new Error('No Ethereum accounts were returned by your wallet.');
      }

      return {
        address: accounts[0],
        chainName: 'Ethereum',
        type: 'ethereum',
      };
    },
  },
  {
    id: 'icp',
    name: 'Plug Wallet',
    chainName: 'ICP',
    installUrl: 'https://plugwallet.ooo/',
    installLabel: 'Install Plug Wallet',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.ic?.plug),
    connect: async () => {
      if (typeof window === 'undefined' || !window.ic?.plug) {
        throw new Error('Plug wallet was not detected in this browser.');
      }

      const connected = await window.ic.plug.requestConnect({
        whitelist: [],
        host: 'https://icp0.io',
      });

      if (!connected) {
        throw new Error('Wallet connection request was rejected.');
      }

      const principal = await window.ic.plug.agent?.getPrincipal?.();
      const address = principal?.toText?.() ?? 'connected-with-plug';

      return {
        address,
        chainName: 'ICP',
        type: 'icp',
      };
    },
  },
  {
    id: 'arweave',
    name: 'ArConnect',
    chainName: 'Arweave',
    installUrl: 'https://www.arconnect.io/download',
    installLabel: 'Install ArConnect',
    isAvailable: () => typeof window !== 'undefined' && Boolean(window.arweaveWallet),
    connect: async () => {
      if (typeof window === 'undefined' || !window.arweaveWallet) {
        throw new Error('ArConnect was not detected in this browser.');
      }

      await window.arweaveWallet.connect(['ACCESS_ADDRESS', 'SIGN_TRANSACTION']);
      const address = await window.arweaveWallet.getActiveAddress();

      return {
        address,
        chainName: 'Arweave',
        type: 'arweave',
      };
    },
  },
];

const snapshotProfiles: SnapshotProfile[] = [
  {
    id: 'clawdbot',
    name: 'Clawdbot / OpenClaw',
    description: 'Capture memory graphs, prompts, and agent runtime configuration.',
    defaultPath: '~/.openclaw',
    snapshotTarget: 'openclaw',
    restoreTarget: 'openclaw',
  },
  {
    id: 'coding-cli',
    name: 'Claude Code / Codex / Gemini CLI',
    description: 'Preserve conversation state, tool context, and coding workspace metadata.',
    defaultPath: '~/.claude',
    snapshotTarget: 'coding-cli',
    restoreTarget: 'coding-cli',
  },
  {
    id: 'goose',
    name: 'Goose',
    description: 'Back up Goose sessions, plugin data, and long-term behaviors.',
    defaultPath: '~/.goose',
    snapshotTarget: 'goose',
    restoreTarget: 'goose',
  },
  {
    id: 'ide-agent',
    name: 'Cursor / Windsurf',
    description: 'Archive IDE assistant context, preferences, and workspace state.',
    defaultPath: '~/.cursor',
    snapshotTarget: 'ide-agent',
    restoreTarget: 'ide-agent',
  },
  {
    id: 'custom',
    name: 'Custom path',
    description: 'Point AgentVault at any local folder and snapshot it deterministically.',
    defaultPath: '~/path/to/agent-folder',
    snapshotTarget: 'custom',
    restoreTarget: 'custom',
  },
];

const backupPhases = [
  {
    id: '01',
    label: 'Create a snapshot',
    description: 'Package local agent state into an encrypted, content-addressed archive.',
    output: 'snapshot.zip + manifest.json',
  },
  {
    id: '02',
    label: 'Sign the request',
    description: 'Sign the backup with your wallet keys before anything touches the chain.',
    output: 'wallet signature + hash proof',
  },
  {
    id: '03',
    label: 'Commit to storage',
    description: 'Write backup records to ICP, with an optional Arweave archival copy.',
    output: 'canister ID + archival transaction',
  },
  {
    id: '04',
    label: 'Verify recovery',
    description: 'Generate a deterministic restore command and an audit receipt.',
    output: 'restore command + replay proof',
  },
];

const ecosystemComponents = [
  {
    id: 'agentvault',
    name: 'AgentVault',
    role: 'Runtime',
    description:
      'Packages your agent to WASM and runs it on an Internet Computer canister — a durable identity, multi-chain wallet, secrets vault, and versioned memory that survive independent of any browser tab or host process.',
    isCurrent: true,
  },
  {
    id: 'smallchat',
    name: 'SmallChat',
    role: 'Tool dispatch',
    description:
      'Deterministic, in-process tool selection instead of stuffing 50+ JSON schemas into a prompt. AgentVault ships a purpose-built implementation of this pattern, wired into policy checks, rate limiting, and MFA gating.',
    isCurrent: false,
  },
  {
    id: 'stenographer',
    name: 'Stenographer',
    role: 'Conversation memory',
    description:
      'An MCP server that passively tails agent logs and builds a searchable GraphRAG index of entities, relations, and decisions — with tombstoned supersession so nothing is silently lost.',
    isCurrent: false,
  },
  {
    id: 'shorthand',
    name: 'Short-Hand',
    role: 'Context compaction',
    description:
      'Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame, replacing naive truncation with importance-ranked retention.',
    isCurrent: false,
  },
];

function shortAddress(address: string): string {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  const trustRow = ['MIT licensed', '508 tests', 'ICP mainnet', 'Multi-chain wallets'];

  return (
    <header className={styles.heroBanner}>
      <div className={clsx('container', styles.heroInner)}>
        <p className={styles.heroKicker}>Open source · v1.0</p>
        <Heading as="h1" className={styles.heroTitle}>
          {siteConfig.tagline}
        </Heading>
        <p className={styles.heroDescription}>
          AgentVault packages your AI agent, deploys it to a durable Internet Computer canister, and keeps it
          running with its own identity, wallet, secrets, and memory — no server to babysit, no session to lose.
        </p>

        <div className={styles.heroButtons}>
          <Link className="button button--secondary button--lg" to="/docs/getting-started/installation">
            Get started
          </Link>
          <a className="button button--outline button--lg" href="#instant-control">
            Try the 1-click installer
          </a>
          <Link className="button button--outline button--lg" to="/docs/getting-started/quick-start">
            Read the quick start
          </Link>
        </div>

        <div className={styles.trustRow}>
          {trustRow.map((item) => (
            <span key={item} className={styles.trustItem}>
              {item}
            </span>
          ))}
        </div>
      </div>
    </header>
  );
}

function EcosystemSection() {
  return (
    <section className={styles.ecosystemSection}>
      <div className="container">
        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>The agent stack</p>
          <Heading as="h2" className={styles.blockTitle}>
            AgentVault is the runtime. It's built to work with the rest of the stack.
          </Heading>
          <p className={styles.blockLead}>
            Long-running agents need more than a place to execute — they need a memory that survives, a way to
            keep that memory inside a token budget, and a cheap, deterministic way to pick the next action.
            AgentVault handles durable execution and already vendors the tool-dispatch pattern from SmallChat;
            Stenographer and Short-Hand plug in as the memory and compaction layers.
          </p>
        </div>

        <div className={styles.ecosystemGrid}>
          {ecosystemComponents.map((component) => (
            <article
              key={component.id}
              className={clsx(styles.ecosystemCard, component.isCurrent && styles.ecosystemCardCurrent)}>
              <div className={styles.ecosystemCardHeader}>
                <Heading as="h3" className={styles.ecosystemCardTitle}>
                  {component.name}
                </Heading>
                <span className={styles.ecosystemCardRole}>{component.role}</span>
              </div>
              <p className={styles.ecosystemCardBody}>{component.description}</p>
              {component.isCurrent ? <span className={styles.ecosystemCardBadge}>You are here</span> : null}
            </article>
          ))}
        </div>

        <div className={styles.deployLinks}>
          <Link className={styles.inlineLink} to="/docs/ecosystem/executive-summary">
            Ecosystem overview
          </Link>
          <Link className={styles.inlineLink} to="/docs/ecosystem/engineering-guide">
            Engineering guide
          </Link>
        </div>
      </div>
    </section>
  );
}

function BackupStudioSection() {
  const [selectedProfileId, setSelectedProfileId] = useState<SnapshotProfileId>('clawdbot');
  const [copiedField, setCopiedField] = useState<'snapshot' | 'restore' | null>(null);

  const selectedProfile = useMemo(
    () => snapshotProfiles.find((profile) => profile.id === selectedProfileId) ?? snapshotProfiles[0],
    [selectedProfileId],
  );

  const snapshotCommand = useMemo(() => {
    if (selectedProfile.id === 'custom') {
      return `agentvault snapshot --path ${selectedProfile.defaultPath}`;
    }

    return `agentvault snapshot --agent ${selectedProfile.snapshotTarget}`;
  }, [selectedProfile]);

  const restoreCommand = useMemo(
    () => `npx agentvault@latest restore --wallet <your-wallet> --agent ${selectedProfile.restoreTarget}`,
    [selectedProfile],
  );

  const handleCopy = async (field: 'snapshot' | 'restore', value: string) => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // Clipboard access can be restricted in some browsers; fail silently.
    }
  };

  return (
    <section className={styles.backupStudioSection}>
      <div className="container">
        <div className={styles.backupStudioHeader}>
          <p className={styles.instantControlLabel}>Backup studio</p>
          <Heading as="h2" className={styles.instantControlTitle}>
            Snapshot, sign, and restore in one flow
          </Heading>
          <p className={styles.instantControlLead}>
            Pick the agent stack you run locally, get the exact snapshot command, and keep restore instructions
            tied to on-chain records.
          </p>
        </div>

        <div className={styles.backupStudioGrid}>
          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 1</p>
              <Heading as="h3" className={styles.panelTitle}>
                Choose your agent
              </Heading>
            </div>
            <div className={styles.profileList}>
              {snapshotProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={clsx(styles.profileButton, selectedProfile.id === profile.id && styles.profileButtonActive)}
                  onClick={() => setSelectedProfileId(profile.id)}>
                  <span className={styles.walletName}>{profile.name}</span>
                  <span className={styles.walletMeta}>{profile.description}</span>
                  <span className={styles.profilePath}>{profile.defaultPath}</span>
                </button>
              ))}
            </div>
          </article>

          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 2</p>
              <Heading as="h3" className={styles.panelTitle}>
                Copy your commands
              </Heading>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Snapshot command</p>
              <pre className={styles.commandShell}>
                <code>{snapshotCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('snapshot', snapshotCommand)}>
                {copiedField === 'snapshot' ? 'Copied' : 'Copy snapshot command'}
              </button>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Restore command</p>
              <pre className={styles.commandShell}>
                <code>{restoreCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('restore', restoreCommand)}>
                {copiedField === 'restore' ? 'Copied' : 'Copy restore command'}
              </button>
            </div>

            <div className={styles.storagePillRow}>
              <span className={styles.storagePill}>Wallet-signed</span>
              <span className={styles.storagePill}>ICP canister</span>
              <span className={styles.storagePill}>Arweave archive</span>
              <span className={styles.storagePill}>Replay-verified</span>
            </div>
          </article>
        </div>

        <article className={styles.timelineCard}>
          <div className={styles.panelHeader}>
            <p className={styles.panelKicker}>How it works</p>
            <Heading as="h3" className={styles.panelTitle}>
              Backup lifecycle
            </Heading>
          </div>

          <div className={styles.timeline}>
            {backupPhases.map((phase) => (
              <div key={phase.id} className={styles.timelineItem}>
                <span className={styles.timelineId}>{phase.id}</span>
                <div>
                  <p className={styles.timelineLabel}>{phase.label}</p>
                  <p className={styles.timelineText}>{phase.description}</p>
                  <p className={styles.timelineOutput}>Output: {phase.output}</p>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.deployLinks}>
            <Link className={styles.inlineLink} to="/docs/user/backups">
              Backup guide
            </Link>
            <Link className={styles.inlineLink} to="/docs/user/troubleshooting">
              Recovery troubleshooting
            </Link>
            <Link className={styles.inlineLink} to="/docs/security/overview">
              Security overview
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}

function GetStartedSection() {
  return (
    <section className={styles.getStartedSection}>
      <div className="container">
        <article className={styles.getStartedCard}>
          <p className={styles.getStartedLabel}>Get started</p>
          <Heading as="h2" className={styles.sectionTitle}>
            From zero to a running agent in three commands
          </Heading>
          <p className={styles.sectionLead}>
            Every agent gets its own canister — a persistent identity, wallet, and memory that keep running
            whether or not you're watching. No infrastructure to provision, no server to keep alive.
          </p>

          <div className={styles.codeBlock}>
            <pre>
              <code>{`# Create a new project
agentvault init my-agent
cd my-agent

# Package and deploy locally
agentvault package ./
agentvault deploy --network local

# Check that it's alive
agentvault status
agentvault health`}</code>
            </pre>
          </div>

          <div className={clsx(styles.admonition, styles.admonitionTip)}>
            <p className={styles.admonitionLabel}>Tip</p>
            <p>
              Wire <code>status</code>, <code>health</code>, and <code>backup</code> into your deployment
              pipeline. Fast recovery should be built in from day one, not bolted on later.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function InstantControlSection() {
  const [selectedWallet, setSelectedWallet] = useState<WalletId | null>(null);
  const [walletConnection, setWalletConnection] = useState<WalletConnection | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletInstall, setWalletInstall] = useState<{label: string; url: string} | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);

  const [projectName, setProjectName] = useState('my-agent');
  const [template, setTemplate] = useState<ProjectTemplate>('default');
  const [installChannel, setInstallChannel] = useState<InstallChannel>('npx');
  const [packagePath, setPackagePath] = useState('./');
  const [network, setNetwork] = useState<DeployNetwork>('local');
  const [canisterId, setCanisterId] = useState('');
  const [copiedAction, setCopiedAction] = useState<'install' | 'deploy' | null>(null);

  const safeProjectName = projectName.trim() || 'my-agent';
  const safePackagePath = packagePath.trim() || './';
  const cliPrefix = installChannel === 'global' ? 'agentvault' : 'npx agentvault@latest';

  const installCommand = useMemo(() => {
    if (installChannel === 'global') {
      return `npm install -g agentvault && agentvault init ${safeProjectName} --template ${template}`;
    }

    return `npx agentvault@latest init ${safeProjectName} --template ${template}`;
  }, [installChannel, safeProjectName, template]);

  const deployCommand = useMemo(() => {
    const deployFlags = canisterId.trim()
      ? `--network ${network} --canister-id ${canisterId.trim()} --upgrade`
      : `--network ${network}`;

    return `cd ${safeProjectName} && ${cliPrefix} package ${safePackagePath} && ${cliPrefix} deploy ${deployFlags}`;
  }, [canisterId, cliPrefix, network, safePackagePath, safeProjectName]);

  const handleConnectWallet = async (wallet: WalletOption) => {
    setSelectedWallet(wallet.id);
    setWalletError(null);
    setWalletInstall(null);

    if (!wallet.isAvailable()) {
      setWalletInstall({label: wallet.installLabel, url: wallet.installUrl});
      return;
    }

    setWalletConnecting(true);
    try {
      const connection = await wallet.connect();
      setWalletConnection(connection);
      setNetwork(connection.type === 'icp' ? 'ic' : 'local');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Wallet connection failed.';
      setWalletError(message);
    } finally {
      setWalletConnecting(false);
    }
  };

  const handleCopy = async (mode: 'install' | 'deploy', value: string) => {
    setWalletError(null);

    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setWalletError('Clipboard access is unavailable in this browser.');
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopiedAction(mode);
      setTimeout(() => setCopiedAction(null), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to copy command.';
      setWalletError(message);
    }
  };

  return (
    <section id="instant-control" className={styles.instantControlSection}>
      <div className="container">
        <div className={styles.instantControlHeader}>
          <p className={styles.instantControlLabel}>1-click installer</p>
          <Heading as="h2" className={styles.instantControlTitle}>
            Connect a wallet, configure your deploy, copy the commands
          </Heading>
          <p className={styles.instantControlLead}>
            Connect your wallet, tune your deployment settings, and get ready-to-run commands for the exact
            environment you're shipping to.
          </p>
        </div>

        <div className={styles.instantControlGrid}>
          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 1</p>
              <Heading as="h3" className={styles.panelTitle}>
                Connect a wallet
              </Heading>
            </div>

            <div className={styles.walletList}>
              {walletOptions.map((wallet) => {
                const isSelected = selectedWallet === wallet.id;
                const isConnected = walletConnection?.type === wallet.id;
                const isAvailable = wallet.isAvailable();

                return (
                  <button
                    key={wallet.id}
                    type="button"
                    className={clsx(styles.walletButton, isSelected && styles.walletButtonActive)}
                    onClick={() => void handleConnectWallet(wallet)}
                    disabled={walletConnecting}>
                    <span className={styles.walletName}>{wallet.name}</span>
                    <span className={styles.walletMeta}>
                      {wallet.chainName} · {isAvailable ? 'detected' : 'not detected'}
                    </span>
                    <span className={styles.walletState}>
                      {walletConnecting && isSelected ? 'Connecting…' : isConnected ? 'Connected' : 'Connect'}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={styles.walletStatus}>
              {walletConnection ? (
                <p className={styles.walletSuccess}>
                  Connected {walletConnection.chainName}: <code>{shortAddress(walletConnection.address)}</code>
                </p>
              ) : (
                <p className={styles.walletHint}>No wallet connected yet.</p>
              )}

              {walletInstall ? (
                <p className={styles.walletHint}>
                  Wallet extension missing.{' '}
                  <a href={walletInstall.url} target="_blank" rel="noreferrer">
                    {walletInstall.label}
                  </a>
                </p>
              ) : null}

              {walletError ? <p className={styles.walletError}>{walletError}</p> : null}
            </div>
          </article>

          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 2</p>
              <Heading as="h3" className={styles.panelTitle}>
                Configure your deploy
              </Heading>
            </div>

            <div className={styles.configGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Project name</span>
                <input
                  className={styles.fieldInput}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Template</span>
                <select
                  className={styles.fieldInput}
                  value={template}
                  onChange={(event) => setTemplate(event.target.value as ProjectTemplate)}>
                  <option value="default">default</option>
                  <option value="minimal">minimal</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Install channel</span>
                <select
                  className={styles.fieldInput}
                  value={installChannel}
                  onChange={(event) => setInstallChannel(event.target.value as InstallChannel)}>
                  <option value="npx">npx</option>
                  <option value="global">global npm</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Package path</span>
                <input
                  className={styles.fieldInput}
                  value={packagePath}
                  onChange={(event) => setPackagePath(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Deploy network</span>
                <select
                  className={styles.fieldInput}
                  value={network}
                  onChange={(event) => setNetwork(event.target.value as DeployNetwork)}>
                  <option value="local">local</option>
                  <option value="ic">ic</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Existing canister ID (optional)</span>
                <input
                  className={styles.fieldInput}
                  placeholder="abcde-aaaab"
                  value={canisterId}
                  onChange={(event) => setCanisterId(event.target.value)}
                />
              </label>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Install</p>
              <pre className={styles.commandShell}>
                <code>{installCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('install', installCommand)}>
                {copiedAction === 'install' ? 'Copied' : 'Copy install command'}
              </button>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Deploy</p>
              <pre className={styles.commandShell}>
                <code>{deployCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('deploy', deployCommand)}>
                {copiedAction === 'deploy' ? 'Copied' : 'Copy deploy command'}
              </button>
            </div>

            <div className={styles.deployLinks}>
              <Link className={styles.inlineLink} to="/docs/getting-started/installation">
                Installation guide
              </Link>
              <Link className={styles.inlineLink} to="/docs/user/deployment">
                Deployment guide
              </Link>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Pathways() {
  return (
    <section className={styles.pathwaysSection}>
      <div className="container">
        <div className={styles.pathGrid}>
          <article className={styles.pathCard}>
            <p className={styles.pathLabel}>Next step</p>
            <Heading as="h3" className={styles.pathTitle}>
              Backups and recovery
            </Heading>
            <p className={styles.pathBody}>
              Configure retention, validate restore drills, and automate backup checks in your deploy pipeline.
            </p>
            <Link className={styles.pathAction} to="/docs/user/backups">
              Open the backup guide →
            </Link>
          </article>

          <article className={styles.pathCard}>
            <p className={styles.pathLabel}>Deep dive</p>
            <Heading as="h3" className={styles.pathTitle}>
              Security and hardening
            </Heading>
            <p className={styles.pathBody}>
              Review production hardening, key custody controls, and incident response strategy.
            </p>
            <Link className={styles.pathAction} to="/docs/security/overview">
              Read the security guide →
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
      title={siteConfig.title}
      description="AgentVault deploys AI agents to Internet Computer canisters with a durable identity, multi-chain wallet, and versioned memory — so they keep running when your laptop doesn't.">
      <HomepageHeader />
      <main className={styles.main}>
        <GetStartedSection />
        <InstantControlSection />
        <BackupStudioSection />
        <HomepageFeatures />
        <EcosystemSection />
        <Pathways />
      </main>
    </Layout>
  );
}
