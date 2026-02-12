/**
 * Key Derivation Module
 *
 * Implements BIP39 seed phrase derivation for wallet keys.
 * Supports multiple derivation paths for different blockchains.
 */

import * as bip39 from 'bip39';
import * as crypto from 'node:crypto';
import bs58 from 'bs58';
import type { WalletCreationMethod } from './types.js';
import { Keypair } from '@solana/web3.js';
import { HDNodeWallet, SigningKey, computeAddress } from 'ethers';

/**
 * Derivation path components
 */
export interface DerivationPathComponents {
  /** Purpose (e.g., 44' for BIP44) */
  purpose: number;
  /** Coin type (e.g., 60' for ETH, 0' for BTC) */
  coinType: number;
  /** Account index */
  account: number;
  /** Change index (0 for external, 1 for internal) */
  change: number;
  /** Address index */
  index: number;
}

/**
 * Derived key information
 */
export interface DerivedKey {
  /** Private key (hex) */
  privateKey: string;
  /** Public key (hex) */
  publicKey: string;
  /** Address (chain-specific format) */
  address: string;
  /** Derivation path used */
  derivationPath: string;
}

/**
 * Default derivation paths for different chains
 */
const DEFAULT_DERIVATION_PATHS: Record<string, string> = {
  // Ethereum / ckETH (BIP44)
  eth: "m/44'/60'/0'/0/0",
  // Polkadot (Substrate)
  polkadot: "//hard//stash",
  // Solana (BIP44)
  solana: "m/44'/501'/0'/0'/0'",
  // Bitcoin
  btc: "m/44'/0'/0'/0/0",
};

/**
 * Parse derivation path string
 *
 * @param path - Derivation path string (e.g., "m/44'/60'/0'/0/0")
 * @returns Parsed path components
 */
export function parseDerivationPath(path: string): DerivationPathComponents {
  const parts = path.split('/');

  if (parts[0] !== 'm') {
    throw new Error('Invalid derivation path: must start with "m"');
  }

  const components: DerivationPathComponents = {
    purpose: 0,
    coinType: 0,
    account: 0,
    change: 0,
    index: 0,
  };

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]?.replace(/'/g, '') || '0';
    const num = parseInt(part, 10);

    switch (i) {
      case 1:
        components.purpose = num;
        break;
      case 2:
        components.coinType = num;
        break;
      case 3:
        components.account = num;
        break;
      case 4:
        components.change = num;
        break;
      case 5:
        components.index = num;
        break;
    }
  }

  return components;
}

/**
 * Build derivation path from components
 *
 * @param components - Path components
 * @returns Derivation path string
 */
export function buildDerivationPath(
  components: DerivationPathComponents
): string {
  const parts = ['m'];

  parts.push(`${components.purpose}'`);
  parts.push(`${components.coinType}'`);
  parts.push(`${components.account}'`);
  parts.push(`${components.change}`);
  parts.push(`${components.index}`);

  return parts.join('/');
}

/**
 * Validate seed phrase (BIP39)
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid BIP39 phrase
 */
export function validateSeedPhrase(seedPhrase: string): boolean {
  return bip39.validateMnemonic(seedPhrase);
}

/**
 * Generate seed from seed phrase
 *
 * @param seedPhrase - BIP39 seed phrase
 * @param passphrase - Optional passphrase (default empty)
 * @returns Seed bytes
 */
export function generateSeedFromMnemonic(
  seedPhrase: string,
  passphrase: string = ''
): Buffer {
  return bip39.mnemonicToSeedSync(seedPhrase, passphrase);
}

/**
 * Generate mnemonic from entropy
 *
 * @param strength - Entropy strength in bits (128, 160, 192, 224, 256)
 * @param rng - Optional RNG function
 * @returns BIP39 mnemonic phrase
 */
export function generateMnemonic(
  strength: number = 128,
  rng?: (size: number) => Buffer
): string {
  return bip39.generateMnemonic(strength, rng);
}

/**
 * Derive key from seed using HMAC-SHA512
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path
 * @returns Derived key (32 bytes private, 32 bytes chain code)
 */
function deriveKeyFromSeed(
  seed: Buffer,
  derivationPath: string
): { privateKey: Buffer; chainCode: Buffer } {
  const parts = parseDerivationPath(derivationPath);

  let key: Buffer = seed.slice(0, 32);
  let chainCode: Buffer = seed.slice(32, 64);

  for (const part of [parts.purpose, parts.coinType, parts.account, parts.change, parts.index]) {
    const isHardened = part >= 0x80000000;

    const data = Buffer.concat([
      key,
      Buffer.from([0x00]),
      Buffer.alloc(4),
    ]);

    data.writeUint32BE(isHardened ? part : part + 0x80000000, 4);

    const hmac = crypto.createHmac('sha512', chainCode);
    hmac.update(data);

    const result = hmac.digest();
    key = result.slice(0, 32);
    chainCode = result.slice(32, 64);
  }

  return { privateKey: key, chainCode };
}

/**
 * Derive Ethereum-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/60'/0'/0/0")
 * @returns Derived key with ETH address
 */
export function deriveEthKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.eth!
): DerivedKey {
  const root = HDNodeWallet.fromSeed(seed);
  const node = root.derivePath(derivationPath);

  const privateKeyHex = stripHexPrefix(node.privateKey);
  const publicKeyHex = stripHexPrefix(SigningKey.computePublicKey(node.privateKey, false));
  const address = node.address;

  return {
    privateKey: privateKeyHex,
    publicKey: publicKeyHex,
    address,
    derivationPath,
  };
}

/**
 * Derive Polkadot-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "//hard//stash")
 * @returns Derived key with Polkadot address
 */
export function derivePolkadotKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.polkadot!
): DerivedKey {
  // Polkadot uses SR25519 and different derivation scheme
  // For now, we'll use a simplified approach
  // In production, use @polkadot/util-crypto for proper derivation

  const privateKey = seed.slice(0, 32);

  // Generate Polkadot address (SS58 format)
  // For now, return placeholder
  const publicKey = derivePublicKey(privateKey);
  const address = derivePolkadotAddress(publicKey);

  return {
    privateKey: privateKey.toString('hex'),
    publicKey: publicKey.toString('hex'),
    address,
    derivationPath,
  };
}

/**
 * Derive Solana-compatible key
 *
 * @param seed - Seed bytes
 * @param derivationPath - Derivation path (default: "m/44'/501'/0'/0'/0'")
 * @returns Derived key with Solana address
 */
export function deriveSolanaKey(
  seed: Buffer,
  derivationPath: string = DEFAULT_DERIVATION_PATHS.solana!
): DerivedKey {
  // Use BIP44 derivation for Solana
  const derived = deriveKeyFromSeed(seed, derivationPath);

  if (!derived || !derived.privateKey) {
    throw new Error('Failed to derive Solana key');
  }

  // Solana uses Ed25519, takes first 32 bytes as seed material
  const privateKeyBytes = derived.privateKey.subarray(0, 32);

  // Use Solana's Keypair for proper Ed25519 key generation
  const keypair = Keypair.fromSeed(privateKeyBytes);

  return {
    privateKey: Buffer.from(keypair.secretKey).toString('hex'),
    publicKey: Buffer.from(keypair.publicKey.toBytes()).toString('hex'),
    address: keypair.publicKey.toBase58(),
    derivationPath,
  };
}

/**
 * Derive public key from private key (simplified)
 *
 * @param privateKey - Private key bytes
 * @returns Public key bytes
 */
function derivePublicKey(privateKey: Buffer): Buffer {
  // Default to secp256k1 for generic key derivation paths.
  // Chain-specific derivation functions should prefer their own primitives.
  const privateKeyHex = `0x${privateKey.toString('hex')}`;
  const publicKeyHex = SigningKey.computePublicKey(privateKeyHex, false);
  return Buffer.from(stripHexPrefix(publicKeyHex), 'hex');
}

/**
 * Derive Polkadot address from public key
 *
 * @param publicKey - Public key bytes
 * @returns Polkadot address (SS58 format)
 */
function derivePolkadotAddress(publicKey: Buffer): string {
  // Simplified Polkadot address derivation
  // In production, use SS58 encoding
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  const addressBytes = hash.slice(0, 32);

  // Simple base58 encoding (not real SS58)
  try {
    return bs58.encode(addressBytes);
  } catch (error) {
    return 'placeholder-polkadot-address';
  }
}

/**
 * Get default derivation path for chain
 *
 * @param chain - Blockchain type
 * @returns Default derivation path
 */
export function getDefaultDerivationPath(chain: string): string {
  switch (chain.toLowerCase()) {
    case 'cketh':
    case 'ethereum':
    case 'eth':
      return DEFAULT_DERIVATION_PATHS.eth!;
    case 'polkadot':
    case 'dot':
      return DEFAULT_DERIVATION_PATHS.polkadot!;
    case 'solana':
    case 'sol':
      return DEFAULT_DERIVATION_PATHS.solana!;
    default:
      return DEFAULT_DERIVATION_PATHS.eth!;
  }
}

/**
 * Derive wallet key based on creation method
 *
 * @param method - Wallet creation method
 * @param seedPhrase - Seed phrase (for 'seed' and 'mnemonic' methods)
 * @param privateKey - Private key (for 'private-key' method)
 * @param derivationPath - Custom derivation path
 * @param chain - Blockchain type
 * @returns Derived key information
 */
export function deriveWalletKey(
  method: WalletCreationMethod,
  seedPhrase?: string,
  privateKey?: string,
  derivationPath?: string,
  chain: string = 'cketh'
): DerivedKey {
  const effectiveDerivationPath =
    derivationPath || getDefaultDerivationPath(chain);

  if (method === 'private-key' && privateKey) {
    const normalizedPrivateKey = normalizePrivateKey(privateKey);
    const privateKeyBuffer = Buffer.from(stripHexPrefix(normalizedPrivateKey), 'hex');

    let address: string;
    let publicKeyHex: string;

    if (chain === 'cketh' || chain === 'ethereum') {
      publicKeyHex = stripHexPrefix(SigningKey.computePublicKey(normalizedPrivateKey, false));
      address = computeAddress(normalizedPrivateKey);
    } else if (chain === 'polkadot') {
      const publicKey = derivePublicKey(privateKeyBuffer);
      publicKeyHex = publicKey.toString('hex');
      address = derivePolkadotAddress(publicKey);
    } else {
      // Solana accepts either 32-byte seed or 64-byte secret key material.
      const keypair = privateKeyBuffer.length >= 64
        ? Keypair.fromSecretKey(privateKeyBuffer.subarray(0, 64))
        : Keypair.fromSeed(privateKeyBuffer.subarray(0, 32));
      publicKeyHex = Buffer.from(keypair.publicKey.toBytes()).toString('hex');
      address = keypair.publicKey.toBase58();
    }

    return {
      privateKey: stripHexPrefix(normalizedPrivateKey),
      publicKey: publicKeyHex,
      address,
      derivationPath: effectiveDerivationPath,
    };
  }

  if ((method === 'seed' || method === 'mnemonic') && seedPhrase) {
    // Derive from seed phrase
    if (!validateSeedPhrase(seedPhrase)) {
      throw new Error('Invalid seed phrase');
    }

    const seed = generateSeedFromMnemonic(seedPhrase);

    if (chain === 'cketh' || chain === 'ethereum') {
      return deriveEthKey(seed, effectiveDerivationPath);
    } else if (chain === 'polkadot') {
      return derivePolkadotKey(seed, effectiveDerivationPath);
    } else if (chain === 'solana') {
      return deriveSolanaKey(seed, effectiveDerivationPath);
    } else {
      return deriveEthKey(seed, effectiveDerivationPath);
    }
  }

  throw new Error(`Invalid wallet creation method: ${method}`);
}

function stripHexPrefix(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function normalizePrivateKey(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}
