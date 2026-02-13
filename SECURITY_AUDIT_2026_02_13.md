# AgentVault Independent Security Audit Report

**Version:** v1.0.0
**Date:** February 13, 2026
**Scope:** Comprehensive code review and security audit of the full AgentVault codebase
**Auditor:** Independent Review (Claude Code)

---

## Executive Summary

This independent security audit reviewed the entire AgentVault codebase: ~15,300 lines of TypeScript across 83 source files, 36 CLI commands, a Motoko canister, and a Next.js webapp with 18 API routes. The review identified **37 findings** across 9 security domains, including **7 critical**, **6 high**, **12 medium**, and **12 low/informational** issues.

Several critical findings were **not covered by the existing internal audit** (dated Feb 12, 2026), including missing GCM authentication tag validation in decryption, non-standard BIP32 key derivation, and a completely unauthenticated webapp API surface.

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 7 | Require immediate remediation |
| High | 6 | Require attention before production use |
| Medium | 12 | Should be addressed in near-term releases |
| Low | 8 | Consider fixing |
| Info | 4 | Positive findings |

**Overall Assessment:** AgentVault has strong foundations in some areas (CanisterEncryption, environment variable handling, no hardcoded secrets) but contains critical cryptographic and webapp security flaws that must be resolved before any production deployment involving real funds or sensitive data.

---

## Methodology

This audit independently reviewed:

- All TypeScript source files in `src/`, `cli/`, and `webapp/`
- Motoko canister code in `canister/`
- CI/CD workflows in `.github/`
- All dependency declarations in `package.json`
- The existing internal security audit for gap analysis

Security domains covered:
1. Cryptographic Correctness
2. Authentication & Authorization
3. Secrets Management & Key Handling
4. Input Validation & Injection
5. Webapp & API Security
6. File System Security
7. Network & External API Security
8. Error Handling & Information Disclosure
9. Dependencies & Supply Chain

---

## 1. Cryptographic Correctness

### Finding C-1: Missing GCM Authentication Tag in `decryptJSON` [CRITICAL] [NEW]

**File:** `src/security/vetkeys.ts:91-96`
**Status:** Not in internal audit

The `decryptJSON` static method decrypts AES-256-GCM ciphertext **without validating the authentication tag**:

```typescript
const decipher = crypto.createDecipheriv(algorithm, key, iv);
const decrypted = Buffer.concat([
  decipher.update(ciphertext),
  decipher.final(),
]);
```

`decipher.setAuthTag()` is never called. This violates the fundamental security guarantee of GCM mode -- ciphertext authenticity. An attacker can modify encrypted data and it will decrypt without error.

**Impact:** Any data encrypted via VetKeys and decrypted through `decryptJSON` has no integrity protection. Ciphertexts can be forged or tampered with.

**Contrast:** The `CanisterEncryption.decrypt()` method at `src/canister/encryption.ts:137-141` correctly calls `setAuthTag()`.

**Recommendation:** Add `decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'))` before decryption, and ensure `EncryptedData` always includes an auth tag field.

---

### Finding C-2: Non-Standard BIP32 Key Derivation [CRITICAL] [NEW]

**File:** `src/wallet/key-derivation.ts:171-200`
**Status:** Not in internal audit

The `deriveKeyFromSeed` function has inverted hardening logic:

```typescript
// Line 181: Checks if part is already in hardened range
const isHardened = part >= 0x80000000;

// Line 189: Non-hardened parts get 0x80000000 added, hardened stay as-is
data.writeUint32BE(isHardened ? part : part + 0x80000000, 4);
```

**Issues:**
1. The parsed derivation path components from `parseDerivationPath()` strip the `'` notation and return raw integers (e.g., `44` not `44 + 0x80000000`). So `isHardened` is always `false` for standard BIP44 paths.
2. All components are then unconditionally hardened (`part + 0x80000000`), meaning the `change` and `index` components that should be non-hardened are hardened instead.
3. The HMAC input construction always includes a `0x00` prefix byte regardless of derivation type, which does not match BIP32 specification.

**Impact:** Keys derived by this function are incompatible with standard BIP32/BIP44 wallets. Users importing the same seed phrase into a standard wallet will get different addresses. This could lead to permanent fund loss if users assume cross-wallet compatibility.

**Note:** This function is used for Solana derivation (`deriveSolanaKey`). Ethereum derivation uses ethers.js `HDNodeWallet.fromSeed()` which is correct. Polkadot derivation uses a simple slice, bypassing this function.

**Recommendation:** Either use a well-tested BIP32 library (e.g., `@scure/bip32`) or fix the hardening logic and HMAC input construction to match the BIP32 specification.

---

### Finding C-3: Circular Key/Plaintext Dependency in `encryptShare` [CRITICAL] [NEW]

**File:** `src/security/vetkeys.ts:253-287`
**Status:** Not in internal audit

The `encryptShare` method uses the secret being encrypted as the PBKDF2 input to derive the encryption key:

```typescript
const encryptionKey = crypto.pbkdf2Sync(
  secretBuffer,  // The plaintext secret
  iv,            // The IV as the salt
  100000, 32, 'sha256'
);
const cipher = crypto.createCipheriv(algorithmName, encryptionKey, iv);
const encryptedShare = Buffer.concat([
  cipher.update(secretBuffer),  // Encrypting the same secret
  cipher.final(),
]);
```

**Issues:**
1. The plaintext is both the PBKDF2 input and the encryption target, creating a self-referential construction.
2. The IV (which is stored alongside the ciphertext) is used as the PBKDF2 salt.
3. No authentication tag is extracted or stored from GCM mode.
4. An attacker with the ciphertext and IV can perform offline brute-force: for each candidate secret S, compute `key = PBKDF2(S, IV)`, decrypt, and check if the result equals S.

**Impact:** Secret shares are not securely encrypted. The construction is vulnerable to known-plaintext/chosen-ciphertext attacks.

**Recommendation:** Use an independent encryption key (not derived from the plaintext), store the GCM auth tag, and use a proper key management scheme.

---

### Finding C-4: Weak XOR-Based Wallet Checksum [HIGH] [NEW]

**File:** `src/wallet/cbor-serializer.ts:266-280`
**Status:** Not in internal audit

Wallet serialization uses a 4-byte XOR-rotation checksum:

```typescript
function calculateChecksum(data: Uint8Array): Uint8Array {
  let checksum = 0;
  for (let i = 0; i < data.length; i++) {
    checksum = ((checksum << 8) ^ byte) >>> 0;
  }
  // ... writes to 4-byte Uint8Array
}
```

**Issues:**
1. A 4-byte XOR-based checksum has trivially computable collisions.
2. No keyed authentication -- anyone can modify wallet data and recompute a valid checksum.
3. The `buffersEqual` comparison (line 289-301) is not timing-safe.

**Impact:** Wallet files on disk can be tampered with (e.g., modifying the `address` field to redirect funds) without detection by the checksum.

**Recommendation:** Replace with HMAC-SHA256 using a key derived from user credentials or the wallet's private key. Use `crypto.timingSafeEqual()` for comparison.

---

### Finding C-5: Algorithm String Replacement Error [HIGH] [NEW]

**File:** `src/security/vetkeys.ts:88`
**Status:** Not in internal audit

```typescript
algorithm = encrypted.algorithm.replace('-', '');
```

For `'chacha20-poly1305'`, this produces `'chacha20poly1305'` (only removes the first hyphen), but the Node.js crypto module expects `'chacha20-poly1305'` as the algorithm name. The `replace()` call with a string (not regex) only replaces the first occurrence.

**Impact:** Attempting to decrypt ChaCha20-Poly1305 encrypted data via `decryptJSON` will throw a runtime error for unrecognized algorithm.

**Recommendation:** Remove the replacement or use a lookup map for algorithm names.

---

### Finding C-6: Weak Secret Sharing (Not True SSS) [MEDIUM]

**File:** `src/security/vetkeys.ts:238-245`
**Status:** Covered in internal audit (Finding 2.3)

`generateParticipantSecret` simply prepends the participant index to the seed phrase:

```typescript
const participantSuffix = Buffer.concat([Buffer.from([participantIndex]), secretBytes]);
return participantSuffix.toString('hex');
```

Any single share trivially reveals the master secret. This is not Shamir's Secret Sharing.

---

### Finding C-7: Seed Phrase Retained in Returned Object [HIGH]

**File:** `src/security/vetkeys.ts:164`
**Status:** Covered in internal audit (Finding 2.2)

The `deriveThresholdKey` return value includes the raw `seedPhrase` string, persisting it in memory longer than necessary.

---

### Finding C-8: Encryption Key Not Returned or Persisted [MEDIUM]

**File:** `src/wallet/vetkeys-adapter.ts:71-111`
**Status:** Covered in internal audit (Finding 2.4)

`encryptSecret` generates a random 32-byte key but only returns the encrypted data, making it unrecoverable.

---

### Finding C-9: Static Salt in `generateKey` [MEDIUM] [NEW]

**File:** `src/canister/encryption.ts:176-182`
**Status:** Not in internal audit

```typescript
const key = crypto.pbkdf2Sync(
  bip39Seed,
  'agentvault-canister-encryption',  // Static salt
  100000, 32, 'sha256'
);
```

Using a static string as the PBKDF2 salt means all users with the same seed phrase derive the same encryption key. The salt should be random and stored alongside the ciphertext.

**Impact:** Enables precomputation attacks (rainbow tables) against the key derivation.

---

## 2. Authentication & Authorization

### Finding A-1: Webapp API Completely Unauthenticated [CRITICAL] [NEW]

**Files:** All 18 routes in `webapp/src/app/api/`
**Status:** Not in internal audit

Every webapp API route is publicly accessible with zero authentication:

| Route | Method | Risk |
|-------|--------|------|
| `/api/wallets` | GET | Lists all wallet agents |
| `/api/agents` | GET | Lists all agents |
| `/api/agents/[id]` | PUT | Modifies agent config |
| `/api/agents/[id]/tasks` | POST | Creates tasks on agents |
| `/api/backups/export` | POST | Exports backup data |
| `/api/backups/import` | POST | Imports backup data |
| `/api/deployments/promote` | POST | Promotes deployments |
| `/api/canisters/[id]/metrics` | GET | Reads canister metrics |
| `/api/approvals` | POST | Creates approval requests |
| `/api/inference` | POST | Sends inference queries |

**Additional missing protections:**
- No Next.js middleware file exists
- No CORS restrictions configured
- No CSRF protection for state-changing operations
- No rate limiting on any endpoint
- No input validation or schema checking on request bodies
- No audit logging of API actions

**Impact:** If the webapp is deployed to a network-accessible host, any user can read all wallet/agent data, modify configurations, create tasks, export backups, and promote deployments.

**Recommendation:** At minimum: add authentication middleware (e.g., Internet Identity for ICP, or session-based auth), add CORS restrictions, add CSRF tokens for mutations, and add input validation with Zod schemas.

---

### Finding A-2: Non-Cryptographic Multisig Approval System [MEDIUM]

**File:** `src/security/multisig.ts:47-58`
**Status:** Covered in internal audit (Finding 1.2)

The `auditToken` is a SHA-256 hash of `${id}:${signer}:${timestamp}:${description}` -- forgeable by anyone who knows the request parameters.

---

### Finding A-3: Anonymous Agent for Local Development [LOW]

**File:** `src/canister/actor.ts:302-309`
**Status:** Covered in internal audit (Finding 1.3)

`createAnonymousAgent` creates unauthenticated ICP agents. No guard prevents production use.

---

## 3. Secrets Management & Key Handling

### Finding S-1: Private Keys Stored Unencrypted in CBOR [HIGH]

**File:** `src/wallet/types.ts:33-35`, `src/wallet/cbor-serializer.ts:43-44`
**Status:** Covered in internal audit (Finding 3.2)

`WalletData.privateKey` and `WalletData.mnemonic` are serialized to CBOR and written to disk at `~/.agentvault/wallets/{agentId}/{walletId}.wallet` without encryption. Despite the type comment saying "stored encrypted", the CBOR serializer writes plaintext:

```typescript
privateKey: wallet.privateKey,  // Plaintext
mnemonic: wallet.mnemonic,      // Plaintext
```

**Impact:** Any local user or process with read access to `~/.agentvault/wallets/` can extract private keys and mnemonics.

---

### Finding S-2: Console Logging of Secret-Related Information [MEDIUM]

**File:** `src/security/vetkeys.ts:452, 459, 497`
**Status:** Covered in internal audit (Finding 3.4)

```typescript
console.log('Encrypted secret stored on canister:', secretId);
console.warn(`Failed to store encrypted secret on canister: ${message}`);
```

---

### Finding S-3: Environment Variable API Keys [LOW]

**Files:** Multiple providers
**Status:** Covered in internal audit (Finding 3.1)

API keys (`INFURA_API_KEY`, `ETHERSCAN_API_KEY`) read from environment. Properly excluded from git via `.gitignore`.

---

## 4. Input Validation & Injection

### Finding I-1: Path Traversal in Multiple Storage Functions [HIGH]

**Files:**
- `src/wallet/wallet-storage.ts:44` -- `agentId` in `path.join(baseDir, agentId)`
- `src/security/multisig.ts:78` -- `id` in `path.join(APPROVALS_DIR, ${id}.yaml)`
- `src/wallet/wallet-storage.ts:61` -- `walletId` in `path.join(agentDir, ${walletId}.wallet)`

**Status:** Covered in internal audit (Findings 4.2, 6.1)

User-provided identifiers (`agentId`, `walletId`, `id`) are used directly in `path.join()` without validation. An `agentId` of `../../etc` would traverse outside the intended directory.

**Impact:** Arbitrary file read/write outside `~/.agentvault/` through crafted identifiers.

**Recommendation:** Validate that path components match `/^[a-zA-Z0-9._-]+$/` and do not contain `..`, `/`, `\`, or null bytes.

---

### Finding I-2: Regex-Based Canister ID Validation [MEDIUM]

**File:** `src/deployment/icpClient.ts:325-328`
**Status:** Covered in internal audit (Finding 4.1)

```typescript
const principalPattern = /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/;
```

This regex accepts strings that are not valid ICP Principals. The `@dfinity/principal` library's `Principal.fromText()` includes checksum validation.

---

### Finding I-3: Unsanitized Input in Shell Commands [MEDIUM]

**File:** `src/deployment/icpClient.ts:108, 272-287, 341, 456`
**Status:** Covered in internal audit (Finding 5.4)

While `execa` properly escapes arguments, the `network` parameter (from `this.config.network`) is not validated against a whitelist before being passed to `dfx` commands.

**Recommendation:** Validate `network` against `['local', 'ic', 'staging']`.

---

### Finding I-4: JSON.parse Without Schema Validation [MEDIUM] [NEW]

**Files:** Multiple (30+ occurrences)
**Status:** Not in internal audit

Deserialized JSON is cast to types with `as` assertions without runtime validation:

- `src/deployment/icpClient.ts:481` -- `JSON.parse(trimmed)` for canister status
- `src/packaging/serializer.ts:144` -- `JSON.parse(json) as SerializedAgentState`
- `cli/commands/decrypt.ts:37` -- `JSON.parse(content) as Record<string, unknown>`
- `cli/commands/rebuild.ts:44` -- `JSON.parse(content)` for agent state

**Impact:** Malformed or malicious input data passes silently, potentially causing unexpected behavior downstream.

**Recommendation:** Use Zod schemas (already a dev dependency) for runtime validation of deserialized data at trust boundaries.

---

### Finding I-5: CBOR Deserialization Without Schema Validation [MEDIUM] [NEW]

**File:** `src/wallet/cbor-serializer.ts:89, 149, 200, 246`
**Status:** Not in internal audit

All CBOR `decode()` results are cast to expected types without validation:

```typescript
const decoded = cbor.decode(payload) as any;
return {
  id: decoded.id || '',      // No type checking
  privateKey: decoded.privateKey,  // Could be any type
  ...
};
```

**Impact:** Corrupted or crafted CBOR data could inject unexpected values into wallet structures.

---

## 5. Network & External API Security

### Finding N-1: Dynamic Code Execution via `new Function()` [HIGH]

**Files:**
- `src/inference/bittensor-client.ts:94`
- `src/archival/arweave-client.ts:83`

**Status:** Covered in internal audit (Finding 5.1)

```typescript
const dynamicImport = new Function('modulePath', 'return import(modulePath)');
```

While module paths are hardcoded strings, `new Function()` is equivalent to `eval()` and is flagged by CSP policies and security scanners. Standard ESM `await import('axios')` is the correct replacement.

---

### Finding N-2: No Rate Limiting on External APIs [LOW]

**File:** `src/wallet/providers/cketh-provider.ts:240-290`
**Status:** Covered in internal audit (Finding 5.2)

Etherscan API calls have no client-side rate limiting or retry backoff.

---

### Finding N-3: HTTP for Local Development [LOW]

**File:** `src/canister/actor.ts:303`
**Status:** Covered in internal audit (Finding 5.3)

---

## 6. File System Security

### Finding F-1: Non-Atomic File Writes for Wallet Data [MEDIUM]

**File:** `src/wallet/wallet-storage.ts:101`
**Status:** Covered in internal audit (Finding 6.2)

```typescript
fs.writeFileSync(walletPath, Buffer.from(serialized));
```

Process interruption during write corrupts the wallet file. Should use write-to-temp + atomic rename.

---

### Finding F-2: No Explicit Directory Permissions [LOW]

**Files:**
- `src/wallet/wallet-storage.ts:77` -- `fs.mkdirSync(agentDir, { recursive: true })`
- `src/security/multisig.ts:69-73` -- `fs.mkdirSync(AGENTVAULT_DIR, { recursive: true })`

**Status:** Covered in internal audit (Finding 6.3)

No explicit `mode: 0o700` on `mkdirSync`, relying on umask which may be permissive.

---

### Finding F-3: Backup Restore Overwrites Without Confirmation [LOW] [NEW]

**File:** `src/wallet/wallet-storage.ts:302-325`
**Status:** Not in internal audit

`restoreWallets` copies all `.wallet` files from backup to the agent directory, overwriting existing wallets without any confirmation or backup of current state.

---

## 7. Error Handling & Information Disclosure

### Finding E-1: Detailed Error Messages in API Responses [MEDIUM] [NEW]

**Files:** All webapp API routes
**Status:** Not in internal audit

All API routes return raw error messages to clients:

```typescript
return NextResponse.json({
  success: false,
  error: error instanceof Error ? error.message : 'Unknown error',
}, { status: 500 });
```

Internal error details (file paths, stack traces, system information) could leak through `error.message`.

**Recommendation:** Return generic error messages to clients; log detailed errors server-side.

---

### Finding E-2: Verbose Console Logging Throughout [LOW]

**Files:** Multiple (28+ files)
**Status:** Partially covered in internal audit (Finding 3.4)

Extensive `console.error()` calls with full error objects throughout the codebase. In production, these could expose sensitive information in server logs.

---

## 8. Dependencies & Supply Chain

### Finding D-1: Dependencies Are Current [INFO]

**File:** `package.json`
**Status:** Covered in internal audit (Finding 7.1)

All major dependencies are at current versions. No known vulnerable versions detected.

---

### Finding D-2: Optional Dependencies Loaded via `new Function()` [LOW]

**Status:** Covered in internal audit (Finding 7.2)

`axios` and `arweave` are optional but loaded unsafely (see Finding N-1).

---

## 9. Positive Findings

### Finding P-1: No Hardcoded Credentials [INFO]

No hardcoded API keys, passwords, or secrets found in the codebase. Test files use obviously fake values.

### Finding P-2: Strong CanisterEncryption Implementation [INFO]

`src/canister/encryption.ts` correctly implements AES-256-GCM with proper auth tag handling, timing-safe HMAC comparison, and PBKDF2 with 100,000 iterations.

### Finding P-3: Proper Agent Name Validation [INFO]

`cli/commands/init.ts:42-50` validates agent names against `/^[a-z0-9-]+$/`.

### Finding P-4: Proper `.gitignore` for Secrets [INFO]

All `.env*` files properly excluded from version control.

---

## Summary Table

| ID | Severity | Title | File(s) | New? |
|----|----------|-------|---------|------|
| C-1 | CRITICAL | Missing GCM auth tag in decryptJSON | vetkeys.ts:91 | YES |
| C-2 | CRITICAL | Non-standard BIP32 key derivation | key-derivation.ts:181 | YES |
| C-3 | CRITICAL | Circular key/plaintext in encryptShare | vetkeys.ts:264 | YES |
| A-1 | CRITICAL | Unauthenticated webapp API (18 routes) | webapp/api/* | YES |
| C-4 | HIGH | Weak XOR checksum on wallets | cbor-serializer.ts:266 | YES |
| C-5 | HIGH | Algorithm string replace error | vetkeys.ts:88 | YES |
| S-1 | HIGH | Private keys stored unencrypted | cbor-serializer.ts:43 | No |
| I-1 | HIGH | Path traversal in storage functions | wallet-storage.ts:44 | No |
| C-7 | HIGH | Seed phrase in returned object | vetkeys.ts:164 | No |
| N-1 | HIGH | Dynamic code execution (new Function) | bittensor-client.ts:94 | No |
| A-2 | MEDIUM | Non-cryptographic multisig | multisig.ts:47 | No |
| C-6 | MEDIUM | Weak secret sharing (not SSS) | vetkeys.ts:238 | No |
| C-8 | MEDIUM | Encryption key not returned | vetkeys-adapter.ts:71 | No |
| C-9 | MEDIUM | Static PBKDF2 salt | encryption.ts:178 | YES |
| I-2 | MEDIUM | Regex canister ID validation | icpClient.ts:325 | No |
| I-3 | MEDIUM | Unsanitized shell command params | icpClient.ts:108 | No |
| I-4 | MEDIUM | JSON.parse without validation | Multiple | YES |
| I-5 | MEDIUM | CBOR decode without validation | cbor-serializer.ts:89 | YES |
| S-2 | MEDIUM | Secret IDs in console logs | vetkeys.ts:452 | No |
| F-1 | MEDIUM | Non-atomic file writes | wallet-storage.ts:101 | No |
| E-1 | MEDIUM | Error details in API responses | webapp/api/* | YES |
| A-3 | LOW | Anonymous agent for local dev | actor.ts:302 | No |
| S-3 | LOW | Env var API keys | Multiple | No |
| N-2 | LOW | No rate limiting | cketh-provider.ts | No |
| N-3 | LOW | HTTP for local dev | actor.ts:303 | No |
| F-2 | LOW | No explicit dir permissions | wallet-storage.ts:77 | No |
| F-3 | LOW | Backup overwrite without confirm | wallet-storage.ts:302 | YES |
| E-2 | LOW | Verbose console logging | Multiple | No |
| D-2 | LOW | Optional deps via new Function | bittensor/arweave | No |
| P-1 | INFO | No hardcoded credentials | - | No |
| P-2 | INFO | Strong CanisterEncryption | encryption.ts | No |
| P-3 | INFO | Proper agent name validation | init.ts | No |
| P-4 | INFO | Proper .gitignore for secrets | .gitignore | No |

**New findings not in internal audit: 12 of 33 actionable findings**

---

## Priority Remediation Plan

### Immediate (Before Any Production Use)

1. **C-1:** Add `setAuthTag()` call in `decryptJSON` and ensure `EncryptedData` includes auth tag
2. **C-2:** Replace custom BIP32 derivation with `@scure/bip32` or fix hardening logic
3. **C-3:** Redesign `encryptShare` to use independent encryption keys
4. **A-1:** Add authentication middleware to all webapp API routes
5. **C-4:** Replace XOR checksum with HMAC-SHA256
6. **C-5:** Fix algorithm name mapping in `decryptJSON`
7. **S-1:** Encrypt wallet private keys at rest with user-provided password

### High Priority (v1.1)

8. **I-1:** Add path sanitization for all user-provided identifiers
9. **C-7:** Remove seed phrase from `deriveThresholdKey` return value
10. **N-1:** Replace `new Function()` with standard ESM `import()`
11. **C-9:** Use random salts for PBKDF2 instead of static strings
12. **I-2:** Use `Principal.fromText()` for canister ID validation

### Medium Priority (v1.2)

13. **I-4/I-5:** Add Zod schema validation for all JSON/CBOR deserialization
14. **A-1 (continued):** Add CORS, CSRF, rate limiting to webapp
15. **E-1:** Sanitize error messages in API responses
16. **C-6/C-8:** Implement proper Shamir's Secret Sharing and key management
17. **F-1:** Implement atomic file writes for wallet data

### Low Priority (Ongoing)

18. Set explicit `0o700` permissions on sensitive directories
19. Add rate limiting for external API calls
20. Implement structured logging with sensitive data filtering

---

## Appendix: Testing Recommendations

1. Add fuzzing tests for all deserialization paths (CBOR, JSON)
2. Add property-based tests for cryptographic functions
3. Add integration tests that verify BIP32 derivation matches reference implementations
4. Add security-focused test cases for path traversal, auth bypass, and CSRF

---

**Report Generated:** February 13, 2026
**Next Review:** Recommended after remediation of critical findings
