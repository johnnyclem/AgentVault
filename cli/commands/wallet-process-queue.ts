/**
 * Wallet Process Queue Command (Phase 5B)
 *
 * CLI command to process pending transactions from canister queue.
 * Part of Phase 5B: Agent-Initiated Transactions.
 * Transactions that ask for a signing threshold above 1 are failed, because
 * threshold signing is not implemented.
 */

import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import type { SignedTransaction, TransactionRequest } from '../../src/wallet/types.js';
import { createWalletProvider } from '../../src/wallet/index.js';
import { looksLikeChainSignature } from '../../src/wallet/chain-signature.js';
import { readThreshold, type QueuedTransaction } from '../../src/wallet/transaction-queue.js';

/**
 * Handle process-queue command
 */
export async function handleProcessQueue(agentId: string, canisterId: string): Promise<void> {
  console.log(chalk.bold('\n🔄 Process Transaction Queue\n'));
  console.log(chalk.yellow('[Experimental] This feature is under active development and may change.\n'));

  const { createActor, createAnonymousAgent } = await import('../../src/canister/actor.js');

  const spinner = ora('Connecting to canister...').start();

  try {
    const agent = createAnonymousAgent();
    const actor = createActor(canisterId, agent);

    spinner.succeed('Connected to canister');

    const stats = await actor.getTransactionQueueStats();

    if (stats.total === 0) {
      console.log(chalk.yellow('No transactions in queue'));
      return;
    }

    console.log();
    console.log(chalk.cyan('Queue Statistics:'));
    console.log(`  Total:     ${stats.total}`);
    console.log(`  Pending:   ${stats.pending}`);
    console.log(`  Queued:    ${stats.queued}`);
    console.log(`  Signed:     ${stats.signed}`);
    console.log(`  Completed:  ${stats.completed}`);
    console.log(`  Failed:     ${stats.failed}`);
    console.log();

    const pending = await actor.getPendingTransactions();

    if (pending.length === 0) {
      console.log(chalk.yellow('No pending transactions to process'));
      return;
    }

    console.log(chalk.cyan(`Found ${pending.length} pending transaction(s)\n`));

    const { processAll } = await inquirer.prompt<{ processAll: boolean }>([
      {
        type: 'confirm',
        name: 'processAll',
        message: `Process all ${pending.length} pending transactions?`,
        default: false,
      },
    ]);

    if (!processAll) {
      console.log(chalk.yellow('\nProcessing cancelled'));
      return;
    }

    spinner.start('Processing transactions...');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const tx of pending) {
      const result = await processTransaction(tx, agentId, actor);

      processed++;
      if (result.success) {
        succeeded++;
        spinner.text = `Processed ${processed}/${pending.length} transactions...`;
      } else {
        failed++;
        spinner.warn(`Transaction ${tx.id} failed: ${result.error}`);
      }
    }

    spinner.succeed(`Processed ${processed} transactions (${succeeded} succeeded, ${failed} failed)`);

    console.log();
    console.log(chalk.green('✓ Queue processing complete'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    spinner.fail(`Processing failed: ${message}`);
  }
}

/**
 * Process a single transaction: sign it with the wallet's own key and send it
 */
async function processTransaction(
  tx: QueuedTransaction,
  agentId: string,
  actor: any
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    // Threshold signing is not implemented: nothing can produce a t-of-n
    // signature, so such a transaction is failed before any wallet key is
    // loaded rather than recorded as signed without a signature. So is one
    // whose threshold cannot be read.
    const threshold = readThreshold(tx.action.threshold);
    if (threshold === null || threshold > 1) {
      const error = threshold === null
        ? `Unreadable signing threshold; transaction ${tx.id} was not signed`
        : `Threshold signing is not implemented; transaction ${tx.id} was not signed`;
      await actor.markTransactionFailed(tx.id, error);
      return { success: false, error };
    }

    const { getWallet } = await import('../../src/wallet/wallet-manager.js');
    const wallet = getWallet(agentId, tx.action.walletId);

    if (!wallet) {
      await actor.markTransactionFailed(tx.id, 'Wallet not found');
      return { success: false, error: 'Wallet not found' };
    }

    const action = mapActionToRequest(tx.action);
    // A provider that cannot sign throws; the catch below records its reason.
    const signed = await signTransaction(wallet, action);

    // A transaction is only recorded as signed when the provider returned
    // something shaped like a chain signature (not missing, "0x" or a short
    // placeholder such as an HMAC).
    if (!looksLikeChainSignature(signed.signature)) {
      const error = 'Signing failed: the wallet provider returned no chain signature';
      await actor.markTransactionFailed(tx.id, error);
      return { success: false, error };
    }

    await actor.markTransactionSigned(tx.id, signed.signature);

    const provider = createProvider(wallet.chain);

    const txResult = await provider.sendTransaction(wallet.address, action);

    await actor.markTransactionCompleted(tx.id, txResult.hash);

    return {
      success: true,
      txHash: txResult.hash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    await actor.markTransactionFailed(tx.id, message);

    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Map canister action to transaction request
 */
function mapActionToRequest(action: QueuedTransaction['action']): TransactionRequest {
  const params = new Map(action.parameters);

  return {
    to: params.get('to') || '',
    amount: params.get('amount') || '0',
    chain: (params.get('chain') || 'cketh') as any,
    memo: params.get('memo'),
    gasPrice: params.get('gasPrice'),
    gasLimit: params.get('gasLimit'),
  };
}

/**
 * Sign transaction with wallet. Throws when the provider cannot sign.
 */
async function signTransaction(
  wallet: any,
  action: TransactionRequest
): Promise<SignedTransaction> {
  const provider = createProvider(wallet.chain);

  return provider.signTransaction(
    {
      to: action.to,
      amount: action.amount,
      chain: action.chain,
    },
    wallet.privateKey
  );
}

/**
 * Create blockchain provider
 */
function createProvider(chain: string): any {
  return createWalletProvider(chain, { isTestnet: false });
}

/**
 * Export handler for use by wallet.ts
 */
export async function handleProcessQueueWithArgs(args: { agentId: string; canisterId: string }): Promise<void> {
  await handleProcessQueue(args.agentId, args.canisterId);
}
