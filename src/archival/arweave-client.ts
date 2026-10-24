/**
 * Arweave Client
 *
 * Handles interaction with Arweave network for permanent data archival.
 * Supports uploading data, retrieving transactions, and checking status.
 */

import type Arweave from 'arweave';

type ArweaveTransaction = Awaited<ReturnType<Arweave['createTransaction']>>;
type ArweaveUploader = Awaited<ReturnType<Arweave['transactions']['getUploader']>>;

export interface ArweaveConfig {
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
  /**
   * Handed to arweave-js, which (as of 1.15) stores it but applies it to no
   * request. Uploads are bounded by `uploadLimits` instead.
   */
  timeout?: number;
  logging?: boolean;
  uploadLimits?: UploadLimits;
}

/**
 * Bounds on one upload. Left to itself arweave-js waits about 40 s before
 * each retry of a failed chunk and gives up only after 100 failures in a row,
 * which can hold a caller (such as a web request) for close to an hour.
 */
export interface UploadLimits {
  /**
   * Longest an upload may run, from asking the gateway for an anchor to the
   * last chunk, before it is reported failed. Default 60 000 ms.
   */
  deadlineMs?: number;
  /** Failed chunk posts allowed in a row before the upload is reported failed. Default 3. */
  maxChunkRetries?: number;
  /** Wait before re-posting a failed chunk. Default 2 000 ms. */
  retryDelayMs?: number;
}

const DEFAULT_UPLOAD_LIMITS: Required<UploadLimits> = {
  deadlineMs: 60_000,
  maxChunkRetries: 3,
  retryDelayMs: 2_000,
};

class UploadDeadlineExceeded extends Error {}

/**
 * Start `work` and settle with it, or reject with UploadDeadlineExceeded once
 * `deadline` (epoch ms) passes; past the deadline, `work` is not started.
 * arweave-js takes no abort signal, so a request already in flight is not
 * cancelled; the caller just stops waiting for it and sends nothing more.
 */
async function beforeDeadline<T>(start: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new UploadDeadlineExceeded();
  }

  const work = start();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UploadDeadlineExceeded()), remaining);
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UploadOptions {
  tags?: Record<string, string>;
  fee?: number;
}

export interface ArchiveTransaction {
  id: string;
  owner: string;
  tags: Record<string, string>;
  size: number;
  timestamp: Date;
  block?: {
    height: number;
    indep_hash: string;
  };
}

export interface UploadResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

export type JWKInterface = Record<string, any>;

export class ArweaveClient {
  private config: Required<Omit<ArweaveConfig, 'uploadLimits'>>;
  private uploadLimits: Required<UploadLimits>;
  private client: any = null;

  constructor(config: ArweaveConfig = {}) {
    this.config = {
      host: config.host || 'arweave.net',
      port: config.port || 443,
      protocol: config.protocol || 'https',
      timeout: config.timeout || 20000,
      logging: config.logging || false,
    };
    const limits = config.uploadLimits ?? {};
    this.uploadLimits = {
      deadlineMs: limits.deadlineMs ?? DEFAULT_UPLOAD_LIMITS.deadlineMs,
      maxChunkRetries: limits.maxChunkRetries ?? DEFAULT_UPLOAD_LIMITS.maxChunkRetries,
      retryDelayMs: limits.retryDelayMs ?? DEFAULT_UPLOAD_LIMITS.retryDelayMs,
    };
  }

  /**
   * Initialize Arweave client (lazy loading)
   */
  private async getClient(): Promise<any> {
    if (!this.client) {
      const ArweaveLibrary = await this.importArweave();
      this.client = new ArweaveLibrary({
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.protocol,
        timeout: this.config.timeout,
        logging: this.config.logging,
      });
    }
    return this.client;
  }

  /**
   * Load the arweave library on first use, so commands that never talk to
   * Arweave do not pay for loading it.
   */
  private async importArweave(): Promise<typeof Arweave> {
    try {
      // SECURITY: Use standard ESM dynamic import instead of new Function()
      // This avoids code execution patterns that can bypass CSP (SEC-4)
      const arweaveModule = await import('arweave');
      return arweaveModule.default;
    } catch (_error) {
      throw new Error(
        'arweave is required for ArweaveClient. Install with: npm install arweave',
      );
    }
  }

  /**
   * Upload data to Arweave. Success means a node accepted the transaction
   * and every chunk, not that it was mined. The upload is bounded by
   * `uploadLimits`: past the deadline, or after too many failed chunk posts in
   * a row, it stops sending and reports failure.
   */
  async uploadData(
    data: string | Buffer,
    jwk: JWKInterface,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const { deadlineMs, maxChunkRetries, retryDelayMs } = this.uploadLimits;
    const deadline = Date.now() + deadlineMs;
    let transactionId: string | undefined;

    try {
      const client = await this.getClient();
      // A string goes up as its UTF-8 bytes and a Buffer as its own bytes, so
      // what lands on Arweave is exactly what the caller hashed and sized.
      const transaction = await beforeDeadline<ArweaveTransaction>(() => client.createTransaction({ data }, jwk), deadline);

      if (options.tags) {
        for (const [key, value] of Object.entries(options.tags)) {
          transaction.addTag(key, value);
        }
      }

      await beforeDeadline(() => client.transactions.sign(transaction, jwk), deadline);
      transactionId = transaction.id;

      // Driven here rather than through transactions.post, which retries
      // failed chunks on arweave-js's own schedule with no overall limit. The
      // first uploadChunk posts the transaction (with its data when it fits
      // in one chunk) and throws if the node rejects it.
      const uploader: ArweaveUploader = await client.transactions.getUploader(transaction);
      let failedInARow = 0;

      while (!uploader.isComplete) {
        await beforeDeadline(() => uploader.uploadChunk(), deadline);

        if (uploader.lastResponseError === '') {
          failedInARow = 0;
          continue;
        }

        failedInARow += 1;
        if (failedInARow > maxChunkRetries) {
          return {
            success: false,
            error:
              `Upload failed: a chunk was rejected ${failedInARow} times in a row ` +
              `(${uploader.lastResponseStatus}: ${uploader.lastResponseError}); ` +
              `transaction ${transactionId} was posted without all of its data`,
          };
        }

        // arweave-js waits about 40 s before retrying a chunk whose last post
        // failed; clearing the error skips that wait, so the retry runs after
        // this shorter one, which the deadline still bounds.
        uploader.lastResponseError = '';
        await sleep(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())));
      }

      return { success: true, transactionId };
    } catch (error) {
      if (error instanceof UploadDeadlineExceeded) {
        return {
          success: false,
          error:
            `Upload did not complete within ${deadlineMs / 1000}s` +
            (transactionId ? ` (transaction ${transactionId} may or may not have been accepted)` : ''),
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Upload JSON data to Arweave
   */
  async uploadJSON<T>(
    jsonData: T,
    jwk: JWKInterface,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    return this.uploadData(JSON.stringify(jsonData), jwk, {
      ...options,
      tags: {
        'Content-Type': 'application/json',
        ...(options.tags || {}),
      },
    });
  }

  /**
   * Get transaction data by ID
   */
  async getTransactionData(transactionId: string): Promise<string | null> {
    try {
      const client = await this.getClient();
      // Without `string: true` arweave hands back a Uint8Array, whose
      // toString() is a comma-separated list of byte values, not the text.
      return await client.transactions.getData(transactionId, {
        decode: true,
        string: true,
      });
    } catch (error) {
      console.error(`Failed to fetch transaction ${transactionId}:`, error);
      return null;
    }
  }

  /**
   * Get transaction status from the gateway's /tx/{id}/status: 200 means
   * mined, 202 means accepted but not yet mined, 404 means the gateway does
   * not know the transaction (never seen, or dropped from the mempool).
   */
  async getTransactionStatus(
    transactionId: string,
  ): Promise<'pending' | 'confirmed' | 'not_found' | 'error'> {
    try {
      const client = await this.getClient();
      const { status, confirmed } = await client.transactions.getStatus(transactionId);

      if (status === 200 && confirmed && confirmed.number_of_confirmations > 0) {
        return 'confirmed';
      }

      if (status === 202) {
        return 'pending';
      }

      if (status === 404) {
        return 'not_found';
      }

      return 'error';
    } catch (error) {
      console.error(`Failed to check status for ${transactionId}:`, error);
      return 'error';
    }
  }

  /**
   * Get transaction info
   */
  async getTransaction(transactionId: string): Promise<ArchiveTransaction | null> {
    try {
      const client = await this.getClient();
      const transaction = await client.transactions.get(transactionId);

      const tags: Record<string, string> = {};
      transaction.get('tags').forEach((tag: any) => {
        const name = tag.get('name', { decode: true, string: true });
        const value = tag.get('value', { decode: true, string: true });
        if (name && value) {
          tags[name] = value;
        }
      });

      const block = transaction.get('block');
      let blockInfo;
      if (block) {
        blockInfo = {
          height: block.get('height'),
          indep_hash: block.get('indep_hash'),
        };
      }

      return {
        id: transaction.id,
        owner: transaction.owner,
        tags,
        size: parseInt(transaction.data_size, 10),
        timestamp: new Date(parseInt(transaction.last_tx, 10) * 1000),
        block: blockInfo,
      };
    } catch (error) {
      console.error(`Failed to fetch transaction ${transactionId}:`, error);
      return null;
    }
  }

  /**
   * Get wallet balance in AR
   */
  async getWalletBalance(address: string): Promise<string> {
    try {
      const client = await this.getClient();
      const balance = await client.wallets.getBalance(address);
      return client.ar.winstonToAr(balance);
    } catch (error) {
      console.error(`Failed to fetch balance for ${address}:`, error);
      return '0';
    }
  }

  /**
   * Estimate upload cost in AR
   */
  async estimateUploadCost(dataSizeBytes: number): Promise<string> {
    try {
      const client = await this.getClient();
      const price = await client.transactions.getPrice(dataSizeBytes);
      return client.ar.winstonToAr(price);
    } catch (error) {
      console.error('Failed to estimate cost:', error);
      return '0';
    }
  }

  /**
   * Generate a new Arweave wallet
   */
  async generateWallet(): Promise<JWKInterface> {
    const client = await this.getClient();
    return client.wallets.generate();
  }

  /**
   * Get wallet address from JWK
   */
  async getAddressFromJWK(jwk: JWKInterface): Promise<string> {
    const client = await this.getClient();
    return client.wallets.jwkToAddress(jwk);
  }

  /**
   * Create Arweave instance
   */
  async getClientInstance(): Promise<any> {
    return this.getClient();
  }
}
