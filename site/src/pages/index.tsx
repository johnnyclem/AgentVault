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

type StackLayer = {
  id: string;
  title: string;
  description: string;
  names: string[];
};

/**
 * The "Bring any model, any agent" cards. Every name is something the code
 * supports today: the inference fallback chain (src/inference, wired into the
 * dashboard's /api/inference), the dashboard's archive profiles, the tool
 * groups the stdio MCP server serves (`agentvault mcp serve`; they are tools,
 * not clients) and the wallet chains (src/wallet/types.ts). Check the code
 * before adding a name here.
 *
 * The dashboard's archive workflow (webapp/src/lib/server/archive-workflow.ts)
 * deploys the packaged agent code and uploads a JSON receipt (canister, file
 * paths, backup manifest) to Arweave. It does not copy the agent's config,
 * skill or memory files anywhere, so the Agents card must not say it does.
 */
const stackLayers: StackLayer[] = [
  {
    id: 'models',
    title: 'Models',
    description:
      "The dashboard's inference API tries a Bittensor subnet, then Venice AI, then a model you run locally with Ollama. Each answer names the one that replied.",
    names: ['Bittensor', 'Venice AI', 'Ollama (local)'],
  },
  {
    id: 'agents',
    title: 'Agents',
    description:
      "Pick your agent's type in the dashboard, deploy it to its own canister and record an archive receipt on Arweave.",
    names: ['Claude Code', 'OpenClaw', 'Goose', 'OpenCode', 'Your own'],
  },
  {
    id: 'mcp-tools',
    title: 'MCP tools',
    description:
      'The built-in MCP server runs over stdio, so any MCP client that can launch a local server gets the same tools.',
    names: ['HyperVault', 'Wiki', 'Total Recall'],
  },
  {
    id: 'chains',
    title: 'Chains',
    description: 'Give each agent wallets of its own, all managed from one CLI.',
    names: ['ICP', 'ckETH', 'Solana', 'Polkadot', 'Arweave'],
  },
];

/**
 * What `agentvault backup export --encrypted` and `agentvault backup restore`
 * actually do (src/backup/backup.ts), in order.
 */
const backupPhases = [
  {
    id: '01',
    label: 'Export',
    description:
      "Stage the agent's state, wallet files, logs, dependencies and WASM, then encrypt the zip with AES-256-GCM.",
    output: '<agent>.zip.enc + <agent>.manifest.json',
  },
  {
    id: '02',
    label: 'Anchor (optional)',
    description: "Upload the manifest and the zip's SHA-256 hash to Arweave. The encrypted zip stays on your machine.",
    output: 'Arweave manifest transaction',
  },
  {
    id: '03',
    label: 'Restore',
    description:
      'Decrypt the zip, refuse unsafe paths and symlinks, restore the state, and install the WASM on a fresh canister.',
    output: 'new canister ID',
  },
];

type EcosystemComponent = {
  id: string;
  name: string;
  role: string;
  description: string;
  /** Package and version of the suite release, for suite components. */
  release?: string;
  /** What AgentVault itself does with this component today. */
  inAgentVault?: string;
  href?: string;
  isCurrent: boolean;
};

const ecosystemComponents: EcosystemComponent[] = [
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
    name: 'smallchat',
    role: 'Tool dispatch',
    release: '@smallchat/core 1.0.0 · SmallChat Swift package 1.0.0',
    description:
      "Semantic tool dispatch. It resolves an intent to at most one tool, checks the arguments against that tool's JSON Schema, and records a replayable proof. The same artifact, embedder and runtime state give the same choice.",
    inAgentVault:
      "Not a dependency. AgentVault's orchestration library has its own opt-in dispatcher modeled on smallchat's selector design: exact selector lookup with class fallback and no embeddings, followed by policy checks, rate limits and MFA gating.",
    href: 'https://www.smallchat.dev',
    isCurrent: false,
  },
  {
    id: 'polytician',
    name: 'Polytician',
    role: 'Semantic memory',
    release: 'polytician 3.0.0',
    description:
      'A local-first MCP server for semantic memory. Each concept can be stored as, and converted between, a 384-dimension vector, markdown and structured ThoughtForm JSON.',
    inAgentVault:
      "AgentVault's orchestrate --polytician-entry option calls a Polytician 3.0 MCP server over stdio, adds the concepts most relevant to the task to Claude's prompt, and saves each session's result as a concept in the agent's own namespace. The polytician push-all, pull and archive commands use Polytician's vault_* tools, which AgentVault turns on by passing Polytician its webapp's URL and token. Pushes reach the memory_repo canister through webapp routes that sign with an identity the repo owner has authorized.",
    href: 'https://polytician.smallchat.dev',
    isCurrent: false,
  },
  {
    id: 'stenographer',
    name: 'Stenographer',
    role: 'Conversation memory',
    release: '@stenographer/core 1.0.0',
    description:
      'An MCP server that indexes agent conversation logs for GraphRAG search and keeps a hash-chained truth ledger. One agent alone settles nothing. A person signs, or two or more agent sessions agree within 15 minutes, each citing its own checkable evidence. Agents never override or rule, and a contested claim goes to a person.',
    inAgentVault: 'Not integrated yet. The engineering guide sketches how it could plug in.',
    href: 'https://stenographer.smallchat.dev',
    isCurrent: false,
  },
  {
    id: 'shorthand',
    name: 'Short-hand',
    role: 'Context compaction',
    release: '@shorthand/core 1.0.0',
    description:
      'Progressive, LSM-tree-style compaction of conversation history into a token-budgeted context frame. Corrections are tracked as tombstones, so overridden facts do not quietly come back.',
    inAgentVault:
      "Not integrated yet. The engineering guide proposes it in place of the Polytician enricher's character-count truncation.",
    href: 'https://short-hand.smallchat.dev',
    isCurrent: false,
  },
];

/**
 * Quote one word for a POSIX shell so a copied command runs as shown. The
 * studio builds commands from free-text inputs: unquoted, a name with a space
 * splits into extra arguments (Commander ignores the excess, so the export
 * silently targets the wrong agent and path) and `<`, `>` or `;` turn into
 * shell syntax. Plain words stay bare so the usual case reads cleanly; `~`
 * stays bare so a home-relative path still expands.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+:,./~-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shortAddress(address: string): string {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 7)}...${address.slice(-5)}`;
}

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  const trustRow = ['MIT licensed', 'Tested in CI', 'ICP mainnet', 'Multi-chain wallets'];

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
        <p className={styles.heroAgnostic}>
          Not tied to one chatbot or one model. Bring Claude Code, OpenClaw, Goose, OpenCode or an agent of your own.
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

function AgnosticSection() {
  return (
    <section className={styles.agnosticSection}>
      <div className="container">
        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>Works with your stack</p>
          <Heading as="h2" className={styles.blockTitle}>
            Bring any model, any agent
          </Heading>
          <p className={styles.blockLead}>
            AgentVault is where your agent lives, not the model it talks to. Each layer gives you more than one
            choice.
          </p>
        </div>

        <div className={styles.agnosticGrid}>
          {stackLayers.map((layer) => (
            <article key={layer.id} className={styles.agnosticCard}>
              <Heading as="h3" className={styles.agnosticCardTitle}>
                {layer.title}
              </Heading>
              <p className={styles.agnosticCardBody}>{layer.description}</p>
              <div className={styles.storagePillRow}>
                {layer.names.map((name) => (
                  <span key={name} className={styles.storagePill}>
                    {name}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className={styles.deployLinks}>
          <Link className={styles.inlineLink} to="/docs/guides/total-recall">
            Total Recall guide
          </Link>
          <Link className={styles.inlineLink} to="/docs/user/wallets">
            Wallets guide
          </Link>
        </div>
      </div>
    </section>
  );
}

function EcosystemSection() {
  return (
    <section className={styles.ecosystemSection}>
      <div className="container">
        <div className={styles.blockHeader}>
          <p className={styles.blockLabel}>The agent stack</p>
          <Heading as="h2" className={styles.blockTitle}>
            AgentVault is the runtime. The smallchat suite covers the rest of the stack.
          </Heading>
          <p className={styles.blockLead}>
            Long-running agents need more than a place to execute. They need a way to pick the next tool, a
            memory that survives, and a way to keep that memory inside a token budget. The smallchat suite
            covers those layers and just shipped 1.0. AgentVault ships on its own schedule: today it has its own
            dispatcher modeled on smallchat and an MCP client for Polytician 3.0, and Stenographer and Short-hand
            are not integrated yet.
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
                {component.release ? <p className={styles.ecosystemCardRelease}>{component.release}</p> : null}
              </div>
              <p className={styles.ecosystemCardBody}>{component.description}</p>
              {component.inAgentVault ? (
                <p className={clsx(styles.ecosystemCardBody, styles.ecosystemCardStatus)}>
                  <strong>In AgentVault:</strong> {component.inAgentVault}
                </p>
              ) : null}
              {component.href ? (
                <a className={clsx(styles.inlineLink, styles.ecosystemCardLink)} href={component.href}>
                  {component.href.replace('https://', '')}
                </a>
              ) : null}
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
  const [agentName, setAgentName] = useState('my-agent');
  const [restoreNetwork, setRestoreNetwork] = useState<DeployNetwork>('local');
  const [anchorOnArweave, setAnchorOnArweave] = useState(false);
  const [arweaveJwkPath, setArweaveJwkPath] = useState('./arweave-key.json');
  const [copiedField, setCopiedField] = useState<'export' | 'restore' | null>(null);

  const safeAgentName = agentName.trim() || 'my-agent';
  const quotedAgentName = shellQuote(safeAgentName);
  const zipPath = shellQuote(`./${safeAgentName}.zip.enc`);
  const wasmPath = shellQuote(`./dist/${safeAgentName}.wasm`);
  const jwkPath = shellQuote(arweaveJwkPath.trim() || './arweave-key.json');

  // Restore deploys the WASM packed into the backup, so the export has to
  // include it; `agentvault package` writes it to dist/<name>.wasm.
  const exportCommand = useMemo(() => {
    const arweaveFlag = anchorOnArweave ? ` --arweave-jwk ${jwkPath}` : '';
    return `agentvault backup export ${quotedAgentName} --encrypted --wasm ${wasmPath} --output ${zipPath}${arweaveFlag}`;
  }, [anchorOnArweave, jwkPath, quotedAgentName, wasmPath, zipPath]);

  const restoreCommand = useMemo(
    () => `agentvault backup restore --zip ${zipPath} --agent ${quotedAgentName} --network ${restoreNetwork}`,
    [quotedAgentName, restoreNetwork, zipPath],
  );

  const handleCopy = async (field: 'export' | 'restore', value: string) => {
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
            Back up and restore in two commands
          </Heading>
          <p className={styles.instantControlLead}>
            Name your agent, choose where it comes back, and copy the exact commands. The backup is encrypted on
            your machine, and a restore installs it on a fresh canister.
          </p>
        </div>

        <div className={styles.backupStudioGrid}>
          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 1</p>
              <Heading as="h3" className={styles.panelTitle}>
                Describe your backup
              </Heading>
            </div>

            <div className={styles.configGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Agent name</span>
                <input
                  className={styles.fieldInput}
                  value={agentName}
                  onChange={(event) => setAgentName(event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Restore to</span>
                <select
                  className={styles.fieldInput}
                  value={restoreNetwork}
                  onChange={(event) => setRestoreNetwork(event.target.value as DeployNetwork)}>
                  <option value="local">local</option>
                  <option value="ic">ic</option>
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Arweave manifest</span>
                <select
                  className={styles.fieldInput}
                  value={anchorOnArweave ? 'upload' : 'skip'}
                  onChange={(event) => setAnchorOnArweave(event.target.value === 'upload')}>
                  <option value="skip">skip</option>
                  <option value="upload">upload</option>
                </select>
              </label>

              {anchorOnArweave ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Arweave key file</span>
                  <input
                    className={styles.fieldInput}
                    value={arweaveJwkPath}
                    onChange={(event) => setArweaveJwkPath(event.target.value)}
                  />
                </label>
              ) : null}
            </div>

            <p className={styles.panelNote}>
              Run the commands from the agent's project folder after <code>agentvault package</code>. After{' '}
              <code>agentvault vault init</code> (HashiCorp Vault or Bitwarden), store the passphrase once with{' '}
              <code>agentvault vault put {quotedAgentName} backup-passphrase</code>; both commands read it from there,
              so it never lands in your shell history.
            </p>
          </article>

          <article className={styles.instantPanel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 2</p>
              <Heading as="h3" className={styles.panelTitle}>
                Copy your commands
              </Heading>
            </div>

            <div className={styles.commandBlock}>
              <p className={styles.commandLabel}>Export command</p>
              <pre className={styles.commandShell}>
                <code>{exportCommand}</code>
              </pre>
              <button
                type="button"
                className={clsx('button button--secondary button--lg', styles.commandButton)}
                onClick={() => void handleCopy('export', exportCommand)}>
                {copiedField === 'export' ? 'Copied' : 'Copy export command'}
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
              <span className={styles.storagePill}>AES-256-GCM</span>
              <span className={styles.storagePill}>Passphrase from Vault</span>
              <span className={styles.storagePill}>Optional Arweave manifest</span>
              <span className={styles.storagePill}>Fresh canister on restore</span>
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
              Export an encrypted backup, restore it to a fresh canister, and manage backup files from the CLI.
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
      description="AgentVault deploys AI agents to Internet Computer canisters with a durable identity, multi-chain wallet, and versioned memory — so they keep running when your laptop doesn't. Not tied to one chatbot or one model.">
      <HomepageHeader />
      <main className={styles.main}>
        <AgnosticSection />
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
