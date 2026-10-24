/**
 * Shape check for signatures returned by wallet providers
 */

/**
 * Whether a provider's `signature` is shaped like a real chain signature:
 * hex (an optional 0x prefix is allowed) of at least 64 bytes, which every
 * signer AgentVault uses produces (Ed25519 and sr25519 give 64 bytes,
 * secp256k1 with recovery id 65). It rejects missing values, the empty
 * string, a bare "0x" and short placeholders such as an HMAC-SHA256 digest
 * (32 bytes).
 *
 * A shape check only: it does not verify the signature.
 */
export function looksLikeChainSignature(signature: unknown): signature is string {
  if (typeof signature !== 'string') {
    return false;
  }
  const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
  return hex.length >= 128 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex);
}
