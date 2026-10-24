/**
 * Wallet providers must never return something that is not a chain signature
 * under the name `signature`. ICP and Arweave have no signer, so they refuse;
 * ckETH returns the real ECDSA signature of the transaction it was asked to
 * sign, including the amount.
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { IcpProvider } from '../../src/wallet/providers/icp-provider.js';
import { ArweaveProvider } from '../../src/wallet/providers/arweave-provider.js';
import { CkEthProvider } from '../../src/wallet/providers/cketh-provider.js';
import { looksLikeChainSignature } from '../../src/wallet/chain-signature.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const RECIPIENT = '0x0987654321fedcba0987654321fedcba09876543';

describe('ICP and Arweave providers', () => {
  it('refuse to sign an ICP transaction instead of returning an HMAC', async () => {
    const provider = new IcpProvider({ chain: 'icp' });
    await expect(
      provider.signTransaction({ to: 'aaaaa-aa', amount: '1', chain: 'icp' }, 'secret'),
    ).rejects.toThrow('Signing ICP transactions is not implemented by this wallet provider');
  });

  it('refuse to sign an Arweave transaction instead of returning an HMAC', async () => {
    const provider = new ArweaveProvider({ chain: 'arweave' });
    await expect(
      provider.signTransaction({ to: 'a'.repeat(43), amount: '1', chain: 'arweave' }, 'secret'),
    ).rejects.toThrow('Signing Arweave transactions is not implemented by this wallet provider');
  });
});

describe('ckETH provider', () => {
  // No network is needed to sign: the RPC URL is never contacted
  const provider = new CkEthProvider({ chain: 'cketh', rpcUrl: 'http://127.0.0.1:9' });

  it('returns the real signature of the requested transfer', async () => {
    const signed = await provider.signTransaction({ to: RECIPIENT, amount: '1.5', chain: 'cketh' }, PRIVATE_KEY);
    const parsed = ethers.Transaction.from(signed.signedTx);

    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signed.signature).toBe(parsed.signature?.serialized);
    expect(ethers.recoverAddress(parsed.unsignedHash, signed.signature!)).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(signed.txHash).toBe(parsed.hash);
    expect(signed.txHash).not.toBe('0x0');
  });

  it('signs the amount it was given, not a zero-value transaction', async () => {
    const signed = await provider.signTransaction(
      { to: RECIPIENT, amount: '1.5', chain: 'cketh', gasPrice: '20000000000', gasLimit: '21000' },
      PRIVATE_KEY,
    );
    const parsed = ethers.Transaction.from(signed.signedTx);

    expect(parsed.to).toBe(ethers.getAddress(RECIPIENT));
    expect(parsed.value).toBe(ethers.parseEther('1.5'));
    expect(parsed.gasPrice).toBe(20000000000n);
    expect(parsed.gasLimit).toBe(21000n);
    expect(parsed.chainId).toBe(1n);
  });

  it('refuses an invalid private key', async () => {
    await expect(provider.signTransaction({ to: RECIPIENT, amount: '1', chain: 'cketh' }, '0x1234')).rejects.toThrow(
      /^Failed to sign transaction:/,
    );
  });
});

describe('looksLikeChainSignature', () => {
  it('accepts 64- and 65-byte hex signatures, with or without 0x', () => {
    expect(looksLikeChainSignature('ab'.repeat(64))).toBe(true);
    expect(looksLikeChainSignature(`0x${'ab'.repeat(65)}`)).toBe(true);
  });

  it('rejects placeholders and non-signatures', () => {
    for (const value of [undefined, null, 42, '', '0x', 'sig-hex', 'ab'.repeat(32), `0x${'zz'.repeat(64)}`, `${'a'.repeat(129)}`]) {
      expect(looksLikeChainSignature(value)).toBe(false);
    }
  });
});
