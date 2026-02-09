/**
 * Cycles Management
 *
 * Provides cycles management via icp-cli.
 * Check balances, mint cycles, transfer cycles.
 */

import { icpcli } from '../icp/icpcli.js';

/**
 * Check cycle balance of a canister.
 *
 * @param canisterId - Canister ID or name
 * @param options - Common ICP options
 * @returns Command result with balance in stdout
 */
export async function checkBalance(
  canister: string,
  options: any = {},
): Promise<IcpCliResult> {
  return icpcli.cyclesBalance({ canister }, options);
}

/**
 * Mint cycles to a canister.
 *
 * @param amount - Amount to mint
 * @param options - Common ICP options
 * @returns Command result
 */
export async function mintCycles(
  amount: string,
  options: any = {},
): Promise<IcpCliResult> {
  return icpcli.cyclesMint({ amount }, options);
}

/**
 * Transfer cycles between canisters.
 *
 * @param amount - Amount to transfer
 * @param to - Recipient principal or canister ID
 * @param options - Common ICP options
 * @returns Command result
 */
export async function transferCycles(
  amount: string,
  to: string,
  options: any = {},
): Promise<IcpCliResult> {
  return icpcli.cyclesTransfer({ amount, to }, options);
}
