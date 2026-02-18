/**
 * Types for wallet operations
 */

/**
 * Supported blockchain types
 */
export type ChainType = 'cketh' | 'polkadot' | 'solana' | 'icp' | 'arweave';

/**
 * Wallet creation methods
 */
export type WalletCreationMethod = 'seed' | 'private-key' | 'mnemonic';

/**
 * Derivation path for BIP39 seed phrases
 */
export type DerivationPath = string;

/**
 * Wallet data structure (stored encrypted)
 */
export interface WalletData {
  /** Unique wallet ID */
  id: string;
  /** Associated agent ID (for per-agent isolation) */
  agentId: string;
  /** Blockchain network */
  chain: ChainType;
  /** Public address */
  address: string;
  /** Encrypted private key (if available) */
  privateKey?: string;
  /** Encrypted mnemonic phrase (if available) */
  mnemonic?: string;
  /** BIP39 derivation path */
  seedDerivationPath?: DerivationPath;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Wallet creation method */
  creationMethod: WalletCreationMethod;
  /** Chain-specific metadata */
  chainMetadata?: Record<string, any>;
}

/**
 * Wallet connection status
 */
export interface WalletConnection {
  /** Wallet ID */
  walletId: string;
  /** Connection status */
  connected: boolean;
  /** Chain-specific provider instance */
  provider: any;
  /** Connection timestamp */
  connectedAt?: number;
}

/**
 * Transaction data
 */
export interface Transaction {
  /** Transaction hash */
  hash: string;
  /** From address */
  from: string;
  /** To address */
  to: string;
  /** Amount (as string to handle large numbers) */
  amount: string;
  /** Blockchain network */
  chain: ChainType;
  /** Transaction timestamp */
  timestamp: number;
  /** Transaction status */
  status: 'pending' | 'confirmed' | 'failed';
  /** Transaction fee */
  fee?: string;
  /** Additional data (memo, etc.) */
  data?: any;
}

/**
 * Wallet balance
 */
export interface Balance {
  /** Amount (as string to handle large numbers) */
  amount: string;
  /** Denomination (ETH, DOT, SOL, etc.) */
  denomination: string;
  /** Blockchain network */
  chain: ChainType;
  /** Wallet address */
  address: string;
  /** Block number (if available) */
  blockNumber?: number;
}

/**
 * Transaction request
 */
export interface TransactionRequest {
  /** Destination address */
  to: string;
  /** Amount to send (as string) */
  amount: string;
  /** Chain network */
  chain: ChainType;
  /** Optional memo (Solana) */
  memo?: string;
  /** Optional gas price (Ethereum/Polkadot) */
  gasPrice?: string;
  /** Optional gas limit (Ethereum/Polkadot) */
  gasLimit?: string;
}

/**
 * Signed transaction data
 */
export interface SignedTransaction {
  /** Signed transaction hash */
  txHash: string;
  /** Raw signed transaction (hex/base58) */
  signedTx: string;
  /** Signature */
  signature?: string;
  /** Transaction request that was signed */
  request: TransactionRequest;
}

/**
 * Wallet creation options
 */
export interface WalletCreationOptions {
  /** Agent ID to associate wallet with */
  agentId: string;
  /** Blockchain network */
  chain: ChainType;
  /** Wallet creation method */
  method: WalletCreationMethod;
  /** Seed phrase (for 'seed' and 'mnemonic' methods) */
  seedPhrase?: string;
  /** Private key (for 'private-key' method) */
  privateKey?: string;
  /** BIP39 derivation path */
  derivationPath?: DerivationPath;
  /** Optional custom wallet ID */
  walletId?: string;
  /** Optional chain-specific metadata */
  chainMetadata?: Record<string, any>;
}

/**
 * Wallet storage options
 */
export interface WalletStorageOptions {
  /** Base directory for wallet storage */
  baseDir?: string;
  /** Enable encryption */
  encrypt?: boolean;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** Blockchain network */
  chain: ChainType;
  /** RPC endpoint URL */
  rpcUrl?: string;
  /** Testnet or mainnet */
  isTestnet?: boolean;
  /** API key (if required) */
  apiKey?: string;
}
