/**
 * Where ICP is sent, and how it becomes cycles.
 *
 * ICP wallets and exchanges send to an account identifier: 32 bytes, a CRC-32 followed by the SHA-224 of
 * the owner's principal and a 32-byte subaccount. The cycles minting canister turns ICP into cycles
 * for whoever asks, once the ICP has been sent to the account that names the asker in its subaccount.
 */

import { createHash } from 'node:crypto';
import { Principal } from '@dfinity/principal';

export const SUBACCOUNT_BYTES = 32;
export const ZERO_SUBACCOUNT = new Uint8Array(SUBACCOUNT_BYTES);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

/** CRC-32 (IEEE), as the ledger checks it. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The 32-byte account identifier of `owner`'s `subaccount`, as bytes. */
export function accountIdentifierBytes(owner: string, subaccount: Uint8Array = ZERO_SUBACCOUNT): Uint8Array {
  if (subaccount.length !== SUBACCOUNT_BYTES) throw new Error(`A subaccount is ${SUBACCOUNT_BYTES} bytes`);
  const hash = createHash('sha224')
    .update(Buffer.from('\x0Aaccount-id'))
    .update(Principal.fromText(owner).toUint8Array())
    .update(subaccount)
    .digest();
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(hash));
  return Uint8Array.from(Buffer.concat([checksum, hash]));
}

/** The account identifier as the lowercase hex wallets show. */
export function accountIdentifier(owner: string, subaccount: Uint8Array = ZERO_SUBACCOUNT): string {
  return Buffer.from(accountIdentifierBytes(owner, subaccount)).toString('hex');
}

/**
 * The subaccount of the minting canister's account that asks it to mint cycles for `principal`: the
 * principal's length, then its bytes, then zeros.
 */
export function mintSubaccount(principal: string): Uint8Array {
  const bytes = Principal.fromText(principal).toUint8Array();
  const subaccount = new Uint8Array(SUBACCOUNT_BYTES);
  subaccount[0] = bytes.length;
  subaccount.set(bytes, 1);
  return subaccount;
}
