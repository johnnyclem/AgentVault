/**
 * Polytician's JSON config file, as `agentvault polytician config` writes it:
 * the agentVault section Polytician reads at startup (it refuses to start when
 * the section does not match its schema). The token is the literal reference
 * ${POLYTICIAN_AV_API_TOKEN}, which Polytician expands from its environment,
 * so no secret is written to disk.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/path-validation.js';
import { agentVaultUrlProblem, PolyticianConfigError } from './polytician-config.js';

/** What agentVault.apiToken holds: Polytician replaces it with its POLYTICIAN_AV_API_TOKEN. */
export const POLYTICIAN_API_TOKEN_REFERENCE = '${POLYTICIAN_AV_API_TOKEN}';

/** Polytician's default memory_repo branch. */
export const DEFAULT_MEMORY_REPO_BRANCH = 'polytician-main';

/** The file Polytician reads when it is started without --config. */
export function defaultPolyticianConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.polytician', 'config.json');
}

export interface PolyticianArchivalOptions {
  /** Polytician archives only concepts carrying every one of these tags */
  tags: string[];
  /** The Arweave wallet (JWK) file that pays for uploads */
  arweaveJwk: string;
}

export interface PolyticianConfigOptions {
  /** AgentVault's webapp base URL (Polytician appends /api/...) */
  apiBaseUrl: string;
  memoryRepoBranch?: string;
  /** Turns archival on; it is off without it */
  archival?: PolyticianArchivalOptions;
}

export interface PolyticianAgentVaultSection {
  apiBaseUrl: string;
  apiToken: string;
  memoryRepoBranch: string;
  archival?: { enabled: true; tagFilter: string[]; arweaveJwk: string };
}

/**
 * The config file's content. Throws PolyticianConfigError for what Polytician
 * would refuse at startup (a URL that is not https or local http, archival
 * without tags), for a URL carrying credentials, and for a wallet file that
 * does not exist or is not an Arweave key: Polytician would start, and every
 * archive would fail. The wallet path is made absolute: Polytician reads
 * arweaveJwk as a file only when it starts with /, ./ or ../, relative to its
 * own working directory.
 */
export function buildPolyticianConfig(options: PolyticianConfigOptions): { agentVault: PolyticianAgentVaultSection } {
  const problem = agentVaultUrlProblem(options.apiBaseUrl, 'The AgentVault URL');
  if (problem) {
    throw new PolyticianConfigError(problem);
  }
  const memoryRepoBranch = options.memoryRepoBranch ?? DEFAULT_MEMORY_REPO_BRANCH;
  if (!memoryRepoBranch.trim()) {
    throw new PolyticianConfigError('The memory_repo branch name is empty');
  }

  const agentVault: PolyticianAgentVaultSection = {
    apiBaseUrl: options.apiBaseUrl,
    apiToken: POLYTICIAN_API_TOKEN_REFERENCE,
    memoryRepoBranch,
  };

  if (options.archival) {
    const { tags, arweaveJwk } = options.archival;
    if (tags.length === 0) {
      throw new PolyticianConfigError(
        'Archival needs at least one --archival-tag: Polytician archives only concepts carrying every listed tag'
      );
    }
    if (tags.some((tag) => !tag.trim())) {
      throw new PolyticianConfigError('An archival tag is empty');
    }
    const jwkPath = path.resolve(arweaveJwk);
    if (!fs.existsSync(jwkPath) || !fs.statSync(jwkPath).isFile()) {
      throw new PolyticianConfigError(`Arweave wallet file not found: ${jwkPath}`);
    }
    checkArweaveWallet(jwkPath);
    agentVault.archival = { enabled: true, tagFilter: [...tags], arweaveJwk: jwkPath };
  }

  return { agentVault };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse a wallet file that is not an Arweave keyfile: an RSA private key as
 * a JWK, with the modulus (n) and private exponent (d) it signs uploads with.
 * The message names the file and never repeats its content.
 */
function checkArweaveWallet(file: string): void {
  let wallet: unknown;
  try {
    wallet = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    wallet = undefined;
  }
  if (!isRecord(wallet) || wallet['kty'] !== 'RSA' || typeof wallet['n'] !== 'string' || typeof wallet['d'] !== 'string') {
    throw new PolyticianConfigError(
      `${file} is not an Arweave wallet: expected an Arweave keyfile, a JSON RSA private key (JWK with kty "RSA", n and d)`
    );
  }
}

/**
 * Whether Polytician's config file holds the AgentVault token itself (a
 * literal agentVault.apiToken, not a ${...} reference to its environment).
 * False for a missing or unreadable file.
 */
export function configFileHasLiteralToken(filePath: string): boolean {
  try {
    const config: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const token = isRecord(config) && isRecord(config['agentVault']) ? config['agentVault']['apiToken'] : undefined;
    return typeof token === 'string' && token.length > 0 && !token.includes('${');
  } catch {
    return false;
  }
}

/** The agentVault keys `agentvault polytician config` writes; an existing file's others are kept. */
const WRITTEN_KEYS = new Set(['apiBaseUrl', 'apiToken', 'memoryRepoBranch']);

/**
 * The agentVault section to write over an existing one: the keys AgentVault
 * writes are set, every other key is kept, and archival is kept unless it is
 * given (its tags and wallet change, other archival settings stay) or removed.
 * kept lists the existing keys left in place.
 */
function mergeAgentVault(
  existing: unknown,
  written: PolyticianAgentVaultSection,
  removeArchival: boolean,
): { agentVault: Record<string, unknown>; kept: string[] } {
  const previous = isRecord(existing) ? existing : {};
  const agentVault: Record<string, unknown> = { ...previous, ...written };
  if (written.archival) {
    agentVault['archival'] = { ...(isRecord(previous['archival']) ? previous['archival'] : {}), ...written.archival };
  } else if (removeArchival) {
    delete agentVault['archival'];
  }
  const kept = Object.keys(previous).filter(
    (key) => !WRITTEN_KEYS.has(key) && !(key === 'archival' && (written.archival || removeArchival))
  );
  return { agentVault, kept };
}

/**
 * Write the config to filePath, readable and writable by its owner only (a
 * new directory for it is owner-only too). An existing file is refused unless
 * force is set; with force, the agentVault keys AgentVault writes are set and
 * every other setting is kept (see mergeAgentVault), so a file that is not a
 * JSON object is refused either way. removeArchival drops an existing
 * archival block. kept lists the existing agentVault keys left in place.
 */
export function writePolyticianConfigFile(
  filePath: string,
  config: { agentVault: PolyticianAgentVaultSection },
  options: { force: boolean; removeArchival?: boolean },
): { path: string; replaced: boolean; kept: string[] } {
  const target = path.resolve(filePath);
  let content: Record<string, unknown> = { ...config };
  let kept: string[] = [];
  const exists = fs.existsSync(target);

  if (exists) {
    if (!options.force) {
      throw new PolyticianConfigError(`${target} already exists; pass --force to update its agentVault settings (its other settings are kept)`);
    }
    let existing: unknown;
    try {
      existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
      existing = undefined;
    }
    if (!isRecord(existing)) {
      throw new PolyticianConfigError(`${target} is not a JSON object; fix or remove it first, since replacing it would lose its settings`);
    }
    const merged = mergeAgentVault(existing['agentVault'], config.agentVault, options.removeArchival === true);
    content = { ...existing, agentVault: merged.agentVault };
    kept = merged.kept;
  }

  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // A new file (the rename's source) is created 0600; it keeps that mode when it replaces the old one
  atomicWriteFileSync(target, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return { path: target, replaced: exists, kept };
}
