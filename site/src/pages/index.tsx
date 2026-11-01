import React, {useMemo, useState} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
} from '@site/src/components/Icons';

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
  /** The names are tried in this order, so they read as a chain. */
  ordered?: boolean;
};

/**
 * The "Bring any model, any agent" rows. Every name is something the code
 * supports today: the inference fallback chain (src/inference, wired into the
 * dashboard's /api/inference), the dashboard's archive profiles, the tool
 * groups the stdio MCP server serves (`agentvault mcp serve`; they are tools,
 * not clients) and the wallet chains (src/wallet/types.ts). Check the code
 * before adding a name here.
 *
 * The dashboard's archive workflow (webapp/src/lib/server/archive-workflow.ts)
 * deploys the packaged agent code and uploads a JSON deployment receipt to
 * Arweave: the agent's id and name, canister id, network and time, and for
 * each artifact its kind, file name and (except for directories and the
 * credential file) size and SHA-256. No paths, no file contents. It does not
 * copy the agent's config, skill or memory files anywhere, so the Agents row
 * must not say it does.
 */
const stackLayers: StackLayer[] = [
  {
    id: 'models',
    title: 'Models',
    description:
      "The dashboard's inference API tries a Bittensor subnet, then Venice AI, then a model you run locally with Ollama. Each answer names the one that replied.",
    names: ['Bittensor', 'Venice AI', 'Ollama (local)'],
    ordered: true,
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
  release?: string[];
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
      'Packages your agent to WASM and runs it on an Internet Computer canister, with a durable identity, multi-chain wallet, secrets vault, and versioned memory that survive independent of any browser tab or host process.',
    isCurrent: true,
  },
  {
    id: 'smallchat',
    name: 'smallchat',
    role: 'Tool dispatch',
    release: ['@smallchat/core 1.0.0', 'SmallChat Swift package 1.0.0'],
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
    release: ['polytician 3.0.0'],
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
    release: ['@stenographer/core 1.0.0'],
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
    release: ['@shorthand/core 1.0.0'],
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

/** One line of the manifest: a mono key, a dotted leader, a mono value. */
function ManifestRow({label, value, accent}: {label: string; value: string; accent?: boolean}) {
  return (
    <div className="av-manifestRow">
      <dt className="av-manifestKey">{label}</dt>
      <dd className={clsx('av-manifestValue', accent && styles.manifestAccent)}>{value}</dd>
    </div>
  );
}

/**
 * The hero object. The commands are the quick start's (README), and the
 * receipt uses the labels `agentvault deploy` prints for the canister it
 * created (cli/commands/deploy.ts). The values are placeholders and the
 * caption says so.
 */
function DeployTerminal() {
  return (
    <figure className={styles.terminalFigure}>
      <div className={styles.terminal}>
        <div className={styles.terminalBar}>
          <span className={styles.terminalTitle}>my-agent</span>
        </div>

        <div className={styles.terminalBody}>
          <p className={clsx(styles.cmd, styles.cmdOptional)}>
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <span className={styles.cmdText}>
              npx agentvault@latest init my-agent <span className={styles.flag}>--template default</span>
            </span>
          </p>
          <p className={clsx(styles.cmd, styles.cmdOptional)}>
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <span className={styles.cmdText}>cd my-agent</span>
          </p>
          <p className={styles.cmd}>
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <span className={styles.cmdText}>agentvault package ./</span>
          </p>
          <p className={styles.cmd}>
            <span className={styles.prompt} aria-hidden="true">
              $
            </span>
            <span className={styles.cmdText}>
              agentvault deploy <span className={styles.flag}>--network ic</span>
            </span>
          </p>
        </div>

        <div className={styles.slip}>
          <div className={styles.slipHead}>
            <p className={styles.slipTitle}>Canister Info</p>
            <p className={styles.slipStatus}>
              <CheckIcon />
              Agent deployed
            </p>
          </div>
          <dl className="av-manifest">
            <ManifestRow label="Canister ID" value="vjk3q-wyaaa-aaaaa-aabqa-cai" accent />
            <ManifestRow label="Network" value="ic" />
            <ManifestRow label="Agent" value="my-agent" />
            <ManifestRow label="Deployed" value="2026-10-31T09:41:07.312Z" />
            <ManifestRow label="WASM Hash" value="3f9a1c0be27d4a58..." />
          </dl>
        </div>
      </div>
      <figcaption className={styles.terminalCaption}>
        Example session. The canister ID and hash are placeholders.
      </figcaption>
    </figure>
  );
}

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();

  return (
    <header className={styles.hero}>
      <div className={clsx('av-wrap', styles.heroGrid)}>
        <div className={styles.heroCopy}>
          <p className={styles.heroKicker}>Open source, MIT licensed</p>
          <Heading as="h1" className={styles.heroTitle}>
            {siteConfig.tagline}
          </Heading>
          <p className={styles.heroDescription}>
            AgentVault packages your AI agent, deploys it to a durable Internet Computer canister, and keeps it
            running with its own identity, wallet, secrets, and memory. No server to babysit, no session to lose.
          </p>
          <p className={styles.heroNote}>
            Not tied to one chatbot or one model. Bring Claude Code, OpenClaw, Goose, OpenCode or an agent of your
            own.
          </p>

          <div className={styles.heroActions}>
            <Link className="button button--secondary button--lg" to="/docs/getting-started/installation">
              Get started
            </Link>
            <a className="button button--outline button--lg" href="#instant-control">
              Try the 1-click installer
            </a>
          </div>
        </div>

        <div className={styles.heroVisual}>
          <DeployTerminal />
        </div>
      </div>
    </header>
  );
}

function SectionHead({label, title, lead}: {label?: string; title: string; lead?: React.ReactNode}) {
  return (
    <div className="av-sectionHead">
      {label ? <p className="av-label">{label}</p> : null}
      <Heading as="h2" className="av-h2">
        {title}
      </Heading>
      {lead ? <p className="av-lead">{lead}</p> : null}
    </div>
  );
}

function AgnosticSection() {
  return (
    <section className={styles.section}>
      <div className="av-wrap">
        <SectionHead
          label="Works with your stack"
          title="Bring any model, any agent"
          lead="AgentVault is where your agent lives, not the model it talks to. Each layer gives you more than one choice."
        />

        <ul className={styles.stackList}>
          {stackLayers.map((layer) => (
            <li key={layer.id} className={styles.stackRow}>
              <Heading as="h3" className={styles.stackTitle}>
                {layer.title}
              </Heading>
              <div className={styles.stackDetail}>
                <p className={styles.stackBody}>{layer.description}</p>
                <ul className={clsx(styles.stackNames, layer.ordered && styles.stackNamesOrdered)}>
                  {layer.names.map((name, index) => (
                    <li key={name}>
                      {layer.ordered && index > 0 ? <ChevronRightIcon /> : null}
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>

        <div className={styles.linkRow}>
          <Link className="av-link" to="/docs/guides/total-recall">
            Total Recall guide
          </Link>
          <Link className="av-link" to="/docs/user/wallets">
            Wallets guide
          </Link>
        </div>
      </div>
    </section>
  );
}

function EcosystemSection() {
  return (
    <section className={styles.section}>
      <div className="av-wrap">
        <SectionHead
          label="The agent stack"
          title="AgentVault is the runtime; the smallchat suite covers the rest of the stack"
          lead="Long-running agents need more than a place to execute. They need a way to pick the next tool, a memory that survives, and a way to keep that memory inside a token budget. The smallchat suite covers those layers and just shipped 1.0. AgentVault ships on its own schedule: today it has its own dispatcher modeled on smallchat and an MCP client for Polytician 3.0, and Stenographer and Short-hand are not integrated yet."
        />

        <ul className={styles.ledger}>
          {ecosystemComponents.map((component) => (
            <li key={component.id} className={clsx(styles.ledgerRow, component.isCurrent && styles.ledgerRowCurrent)}>
              <div className={styles.ledgerName}>
                <Heading as="h3" className={styles.ledgerTitle}>
                  {component.name}
                </Heading>
                <p className={styles.ledgerRole}>{component.role}</p>
                {component.href ? (
                  <a className={clsx('av-link', styles.ledgerLink)} href={component.href}>
                    {component.href.replace('https://', '')}
                    <ArrowUpRightIcon />
                  </a>
                ) : null}
              </div>

              <div className={styles.ledgerBody}>
                {component.release ? (
                  <dl className={clsx('av-manifest', styles.ledgerRelease)}>
                    {component.release.map((value) => (
                      <ManifestRow key={value} label="Release" value={value} />
                    ))}
                  </dl>
                ) : null}
                <p>{component.description}</p>
              </div>

              {component.inAgentVault ? (
                <p className={clsx(styles.ledgerBody, styles.ledgerStatus)}>
                  <strong>In AgentVault:</strong> {component.inAgentVault}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        <div className={styles.linkRow}>
          <Link className="av-link" to="/docs/ecosystem/executive-summary">
            Ecosystem overview
          </Link>
          <Link className="av-link" to="/docs/ecosystem/engineering-guide">
            Engineering guide
          </Link>
        </div>
      </div>
    </section>
  );
}

type CommandBlockProps = {
  label: string;
  command: string;
  copyLabel: string;
  copied: boolean;
  onCopy: () => void;
};

/** A command the visitor copies: label and copy button above, the whole command below. */
function CommandBlock({label, command, copyLabel, copied, onCopy}: CommandBlockProps) {
  return (
    <div className={styles.command}>
      <div className={styles.commandHead}>
        <p className={styles.commandLabel}>{label}</p>
        <button type="button" className={styles.copyButton} aria-label={copyLabel} onClick={onCopy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className={styles.commandShell}>
        <code>{command}</code>
      </pre>
    </div>
  );
}

/** A native select with the set's chevron in place of the browser's arrow. */
function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{value: string; label: string}>;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.selectWrap}>
        <select className={clsx(styles.fieldInput, styles.fieldSelect)} value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className={styles.selectIcon} />
      </span>
    </label>
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
    <section className={styles.section}>
      <div className="av-wrap">
        <SectionHead
          title="Back up and restore in two commands"
          lead="Name your agent, choose where it comes back, and copy the exact commands. The backup is encrypted on your machine, and a restore installs it on a fresh canister."
        />

        <div className={styles.toolGrid}>
          <article className={styles.panel}>
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

              <SelectField
                label="Restore to"
                value={restoreNetwork}
                onChange={(value) => setRestoreNetwork(value as DeployNetwork)}
                options={[
                  {value: 'local', label: 'local'},
                  {value: 'ic', label: 'ic'},
                ]}
              />

              <SelectField
                label="Arweave manifest"
                value={anchorOnArweave ? 'upload' : 'skip'}
                onChange={(value) => setAnchorOnArweave(value === 'upload')}
                options={[
                  {value: 'skip', label: 'skip'},
                  {value: 'upload', label: 'upload'},
                ]}
              />

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

          <article className={styles.panel}>
            <div className={styles.panelHeader}>
              <p className={styles.panelKicker}>Step 2</p>
              <Heading as="h3" className={styles.panelTitle}>
                Copy your commands
              </Heading>
            </div>

            <CommandBlock
              label="Export command"
              command={exportCommand}
              copyLabel="Copy export command"
              copied={copiedField === 'export'}
              onCopy={() => void handleCopy('export', exportCommand)}
            />

            <CommandBlock
              label="Restore command"
              command={restoreCommand}
              copyLabel="Copy restore command"
              copied={copiedField === 'restore'}
              onCopy={() => void handleCopy('restore', restoreCommand)}
            />

            <p className={styles.metaLine}>
              AES-256-GCM · Passphrase from Vault · Optional Arweave manifest · Fresh canister on restore
            </p>
          </article>
        </div>

        <article className={styles.sheet} aria-label="Backup lifecycle">
          <div className={styles.sheetIntro}>
            <Heading as="h3" className={styles.sheetTitle}>
              Backup lifecycle
            </Heading>
            <p className={styles.sheetLead}>Three steps. Each one lists what it leaves behind.</p>
            <div className={styles.sheetLinks}>
              <Link className="av-link" to="/docs/user/backups">
                Backup guide
              </Link>
              <Link className="av-link" to="/docs/user/troubleshooting">
                Recovery troubleshooting
              </Link>
              <Link className="av-link" to="/docs/security/overview">
                Security overview
              </Link>
            </div>
          </div>

          <ol className={styles.timeline}>
            {backupPhases.map((phase) => (
              <li key={phase.id} className={styles.timelineItem}>
                <span className={styles.timelineId}>{phase.id}</span>
                <div className={styles.timelineBody}>
                  <p className={styles.timelineLabel}>{phase.label}</p>
                  <p className={styles.timelineText}>{phase.description}</p>
                  <dl className={clsx('av-manifest', styles.timelineOutput)}>
                    <ManifestRow label="Output" value={phase.output} />
                  </dl>
                </div>
              </li>
            ))}
          </ol>
        </article>
      </div>
    </section>
  );
}

const quickStartCommands = `# Create a new project
agentvault init my-agent
cd my-agent

# Package and deploy locally
agentvault package ./
agentvault deploy --network local

# Check that it's alive
agentvault status
agentvault health`;

function GetStartedSection() {
  return (
    <section className={styles.section}>
      <div className="av-wrap">
        <div className={styles.startGrid}>
          <div className={styles.startCopy}>
            <p className="av-label">Get started</p>
            <Heading as="h2" className="av-h2">
              From zero to a running agent in three steps
            </Heading>
            <p className="av-lead">
              Every agent gets its own canister, a persistent identity, wallet, and memory that keep running whether
              or not you're watching. No infrastructure to provision, no server to keep alive.
            </p>

            <p className={styles.note}>
              Wire <code>status</code>, <code>health</code>, and <code>backup</code> into your deployment pipeline.
              Fast recovery should be built in from day one, not bolted on later.
            </p>

            <div className={styles.linkRow}>
              <Link className="av-link" to="/docs/getting-started/quick-start">
                Read the quick start
                <ArrowRightIcon />
              </Link>
            </div>
          </div>

          <div className={styles.startCode}>
            <pre>
              <code>
                {quickStartCommands.split('\n').map((line, index) => (
                  <span key={index} className={clsx(styles.codeLine, line.startsWith('#') && styles.codeComment)}>
                    {line}
                    {'\n'}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
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
      ? `--network ${network} --canister-id ${canisterId.trim()} --mode upgrade`
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
    <section id="instant-control" className={styles.section}>
      <div className="av-wrap">
        <SectionHead
          title="Connect a wallet and copy your deploy commands"
          lead="Connect your wallet, tune your deployment settings, and get ready-to-run commands for the exact environment you're shipping to."
        />

        <div className={styles.toolGrid}>
          <article className={styles.panel}>
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
                    <span className={styles.walletState}>
                      {walletConnecting && isSelected ? 'Connecting…' : isConnected ? 'Connected' : 'Connect'}
                    </span>
                    <span className={styles.walletMeta}>
                      {wallet.chainName} · {isAvailable ? 'detected' : 'not detected'}
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
                <p className={styles.walletHint}>No wallet connected yet</p>
              )}

              {walletInstall ? (
                <p className={styles.walletHint}>
                  Wallet extension missing:{' '}
                  <a href={walletInstall.url} target="_blank" rel="noreferrer">
                    {walletInstall.label}
                  </a>
                </p>
              ) : null}

              {walletError ? (
                <p className={styles.walletError} role="alert">
                  {walletError}
                </p>
              ) : null}
            </div>

            <p className={styles.panelNote}>
              Connecting Plug Wallet sets the deploy network to <code>ic</code>. MetaMask and ArConnect set it to{' '}
              <code>local</code>. You can change it in step 2.
            </p>
          </article>

          <article className={styles.panel}>
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

              <SelectField
                label="Template"
                value={template}
                onChange={(value) => setTemplate(value as ProjectTemplate)}
                options={[
                  {value: 'default', label: 'default'},
                  {value: 'minimal', label: 'minimal'},
                ]}
              />

              <SelectField
                label="Install channel"
                value={installChannel}
                onChange={(value) => setInstallChannel(value as InstallChannel)}
                options={[
                  {value: 'npx', label: 'npx'},
                  {value: 'global', label: 'global npm'},
                ]}
              />

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Package path</span>
                <input
                  className={styles.fieldInput}
                  value={packagePath}
                  onChange={(event) => setPackagePath(event.target.value)}
                />
              </label>

              <SelectField
                label="Deploy network"
                value={network}
                onChange={(value) => setNetwork(value as DeployNetwork)}
                options={[
                  {value: 'local', label: 'local'},
                  {value: 'ic', label: 'ic'},
                ]}
              />

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

            <CommandBlock
              label="Install"
              command={installCommand}
              copyLabel="Copy install command"
              copied={copiedAction === 'install'}
              onCopy={() => void handleCopy('install', installCommand)}
            />

            <CommandBlock
              label="Deploy"
              command={deployCommand}
              copyLabel="Copy deploy command"
              copied={copiedAction === 'deploy'}
              onCopy={() => void handleCopy('deploy', deployCommand)}
            />
          </article>
        </div>

        <div className={styles.linkRow}>
          <Link className="av-link" to="/docs/getting-started/installation">
            Installation guide
          </Link>
          <Link className="av-link" to="/docs/user/deployment">
            Deployment guide
          </Link>
        </div>
      </div>
    </section>
  );
}

function Pathways() {
  return (
    <section className={clsx(styles.section, styles.sectionLast)}>
      <div className="av-wrap">
        <div className={styles.pathGrid}>
          <article className={styles.pathCard}>
            <p className="av-label">Next step</p>
            <Heading as="h3" className={styles.pathTitle}>
              Backups and recovery
            </Heading>
            <p className={styles.pathBody}>
              Export an encrypted backup, restore it to a fresh canister, and manage backup files from the CLI.
            </p>
            <Link className="av-link" to="/docs/user/backups">
              Open the backup guide
              <ArrowRightIcon />
            </Link>
          </article>

          <article className={styles.pathCard}>
            <p className="av-label">Deep dive</p>
            <Heading as="h3" className={styles.pathTitle}>
              Security and hardening
            </Heading>
            <p className={styles.pathBody}>
              Review production hardening, key custody controls, and incident response strategy.
            </p>
            <Link className="av-link" to="/docs/security/overview">
              Read the security guide
              <ArrowRightIcon />
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
      description="AgentVault deploys AI agents to Internet Computer canisters with a durable identity, multi-chain wallet, and versioned memory, so they keep running when your laptop doesn't. Not tied to one chatbot or one model.">
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
