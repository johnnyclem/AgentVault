/**
 * ckETH Wallet Provider
 *
 * Provider for Ethereum-compatible wallets on ICP ckETH.
 * Supports balance queries, transactions, and signing.
 */

import { ethers } from 'ethers';
import type {
  Balance,
  Transaction,
  TransactionRequest,
  SignedTransaction,
  ProviderConfig,
} from '../types.js';
import { BaseWalletProvider } from './base-provider.js';

/**
 * ckETH provider configuration
 */
interface CkEthConfig extends ProviderConfig {
  /** Ethereum JSON-RPC endpoint */
  rpcUrl: string;
  /** Chain ID (1 = Mainnet, 5 = Goerli, 11155111 = Sepolia) */
  chainId?: number;
}

/**
 * ckETH wallet provider
 */
export class CkEthProvider extends BaseWalletProvider {
  private provider: ethers.JsonRpcProvider | null = null;
  private chainId: number;

  constructor(config: CkEthConfig) {
    super(config);
    this.chainId = config.chainId ?? 1; // Default to mainnet
  }

  /**
   * Connect to Ethereum network via RPC
   */
  async connect(): Promise<void> {
    try {
      // Create provider
      this.provider = new ethers.JsonRpcProvider(this.getRpcUrl());
      
      // Verify connection
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      this.connected = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to connect to ckETH network: ${message}`);
    }
  }

  /**
   * Disconnect from network
   */
  async disconnect(): Promise<void> {
    this.provider = null;
    this.connected = false;
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<Balance> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const balance = await this.provider.getBalance(address);
      const etherBalance = ethers.formatEther(balance);

      return {
        amount: etherBalance,
        denomination: 'ETH',
        chain: this.getChain(),
        address,
        blockNumber: await this.provider.getBlockNumber(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get balance: ${message}`);
    }
  }

  /**
   * Send transaction
   */
  async sendTransaction(
    from: string,
    request: TransactionRequest
  ): Promise<Transaction> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const tx = await this.populateTransaction(from, request);
      const signedTx = await this.signTransaction(tx, from);

      // Send transaction
      const txResponse = await this.provider.broadcastTransaction(signedTx.signedTx);

      return {
        hash: txResponse.hash,
        from,
        to: request.to,
        amount: request.amount,
        chain: this.getChain(),
        timestamp: Date.now(),
        status: 'pending',
        fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to send transaction: ${message}`);
    }
  }

  /**
   * Sign transaction
   */
  async signTransaction(
    tx: any,
    privateKey: string
  ): Promise<SignedTransaction> {
    try {
      const wallet = new ethers.Wallet(privateKey);
      const signedTxSerialized = await wallet.signTransaction(tx);

      return {
        txHash: tx.hash || '0x0',
        signedTx: signedTxSerialized,
        signature: '0x',
        request: tx,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign transaction: ${message}`);
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(_address: string): Promise<Transaction[]> {
    // For MVP, return empty array
    // In production, query blockchain or use Etherscan API
    return [];
  }

  /**
   * Validate Ethereum address
   */
  validateAddress(address: string): boolean {
    try {
      return ethers.isAddress(address);
    } catch {
      return false;
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(request: TransactionRequest): Promise<string> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const feeData = await this.provider.getFeeData();
      const gasLimit = await this.provider.estimateGas({
        to: request.to,
        value: ethers.parseEther(request.amount),
      });

      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || BigInt(0);
      const fee = gasPrice * gasLimit;
      return ethers.formatEther(fee);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to estimate fee: ${message}`);
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    return await this.provider.getBlockNumber();
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) {
        return null;
      }

      const receipt = await this.provider.getTransactionReceipt(txHash);

      return {
        hash: tx.hash,
        from: tx.from,
        to: tx.to || '',
        amount: ethers.formatEther(tx.value),
        chain: this.getChain(),
        timestamp: (await this.provider.getBlock(tx.blockNumber || 0))?.timestamp || 0,
        status: receipt ? (receipt.status ? 'confirmed' : 'failed') : 'pending',
        fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get transaction: ${message}`);
    }
  }

  /**
   * Create transaction from request
   */
  private async populateTransaction(
    from: string,
    request: TransactionRequest
  ): Promise<any> {
    const tx = {
      to: request.to,
      value: ethers.parseEther(request.amount),
      from,
      gasLimit: request.gasLimit ? BigInt(parseInt(request.gasLimit)) : undefined,
      gasPrice: request.gasPrice ? BigInt(parseInt(request.gasPrice)) : undefined,
    };

    return tx;
  }

  /**
   * Get default RPC URL for chain
   */
  static getDefaultRpcUrl(isTestnet: boolean = false): string {
    if (isTestnet) {
      return 'https://sepolia.infura.io/v3/YOUR-API-KEY'; // Sepolia testnet
    }
    return 'https://mainnet.infura.io/v3/YOUR-API-KEY'; // Ethereum mainnet
  }

  /**
   * Get chain ID
   */
  getChainId(): number {
    return this.chainId;
  }
}
