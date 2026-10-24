# Wallet Guide

This guide covers wallet management, transactions, and cycles in AgentVault.

## Overview

AgentVault supports multi-chain wallets:
- **ICP (Internet Computer)** - Primary wallet for canister operations
- **Polkadot** - For cross-chain transactions
- **Solana** - For DeFi and DApp interactions

## Wallet Types

### Local Wallet

Encrypted wallet stored locally on disk:

```bash
# Create local wallet
agentvault wallet create

# Features:
# - Encrypted storage (AES-256)
# - Hardware wallet compatibility
# - Multiple accounts support
```

### Hardware Wallet

Generate a wallet's key on a Ledger device (or in an Intel SGX enclave):

```bash
# The private key stays on the device; AgentVault stores the public key and address
agentvault wallet create --chain cketh --agent-id my-agent --hsm ledger
```

`wallet sign` does not use the device yet. It needs a private key on disk, so
it cannot sign for a hardware wallet.

## Creating Wallets

### ICP Wallet

```bash
# Create new ICP wallet
agentvault wallet create --network icp

# Output: Wallet ID and principal
```

### Importing Wallet

Import existing wallet from mnemonic or private key:

```bash
# Import from mnemonic
agentvault wallet import --mnemonic

# Import from private key
agentvault wallet import --private-key
```

## Wallet Commands

### List Wallets

View all connected wallets:

```bash
agentvault wallet list
```

### Wallet Balance

Check wallet balance:

```bash
# Check all wallets
agentvault wallet balance

# Check specific wallet
agentvault wallet balance <wallet-id>
```

### Sign Transaction

Sign a transfer with one of an agent's wallets:

```bash
# Interactive: pick a wallet, then enter the recipient and amount
agentvault wallet sign --agent-id <agent-id>
```

`wallet sign` signs ckETH, Solana and Polkadot transfers with the wallet's own
key, prints the signed transaction and offers to save it under
`.agentvault/signed-txs/` in the current folder. It does not broadcast it.
Signing is not implemented for ICP and Arweave wallets: for those the command
fails and saves nothing.

### Transaction History

View transaction history:

```bash
# View all transactions
agentvault wallet history

# View wallet-specific
agentvault wallet history <wallet-id>

# Filter by type
agentvault wallet history --type send
agentvault wallet history --type receive
```

### Export Wallet

Export wallet keys for backup:

```bash
# Export to JSON
agentvault wallet export <wallet-id> --format json

# Export to mnemonic (use with caution)
agentvault wallet export <wallet-id> --format mnemonic --show
```

## Cycles Management

### Top-up Cycles

Add cycles to wallet:

```bash
# Top-up canister
agentvault wallet top-up <canister-id> --amount 1000000000000

# Options:
# --network icp      - Target network
# --auto-refill     - Enable auto-refill
```

### Transfer Cycles

Transfer cycles between wallets:

```bash
# Transfer cycles
agentvault wallet transfer --from <wallet-id> --to <wallet-id> --amount 1000000000000
```

### Multi-send

Send cycles to multiple recipients:

```bash
# Batch transfer
agentvault wallet multi-send --input transfers.json

# Input format:
# {
#   "transfers": [
#     { "to": "recipient-1", "amount": 1000000000000 },
#     { "to": "recipient-2", "amount": 5000000000000 }
#   ]
# }
```

### Process Queue

Process the transactions an agent's canister has queued:

```bash
# Prompts for the canister ID
agentvault wallet process-queue --agent-id <agent-id>
```

The command is meant to sign each pending transaction with the wallet's own
key, record the signature on the canister and then send it. It refuses a
transaction that asks for a signing threshold above 1, because threshold
signing is not implemented. Today it calls the canister without a signing
identity, and the canister refuses anonymous writes, so recording fails and
nothing is sent.

## Cross-Chain Operations

### Polkadot

```bash
# Create Polkadot wallet
agentvault wallet create --chain polkadot

# Check balance
agentvault wallet balance <wallet-id> --chain polkadot

# Transfer tokens
agentvault wallet transfer --chain polkadot --to <address> --amount 1000
```

### Solana

```bash
# Create Solana wallet
agentvault wallet create --chain solana

# Check balance
agentvault wallet balance <wallet-id> --chain solana

# Transfer SOL
agentvault wallet transfer --chain solana --to <address> --amount 1.5
```

## Security Best Practices

### Key Management

- [ ] **Never share mnemonics** - Store securely, never transmit
- [ ] **Use hardware wallets** - For large holdings
- [ ] **Regular backups** - Export wallet to secure location
- [ ] **Verify addresses** - Double-check before sending
- [ ] **Use test transactions** - Small amounts first

### Transaction Safety

- [ ] **Verify recipient address** - Copy-paste carefully
- [ ] **Confirm amounts** - Large transactions, double-check
- [ ] **Review transaction details** - Before broadcasting
- [ ] **Monitor confirmations** - Check on-chain status
- [ ] **Keep records** - Save transaction IDs for reference

### Recovery

**Lost mnemonic?**
```bash
# Can only recover with mnemonic
agentvault wallet restore --mnemonic "word1 word2 word3 ..."

# No way to recover without mnemonic
```

**Lost private key?**
```bash
# Cannot recover
# Generate new wallet with remaining funds
```

## Troubleshooting

### Wallet Not Found

```bash
# List all wallets
agentvault wallet list

# Verify wallet ID
agentvault wallet info <wallet-id>
```

### Insufficient Balance

```bash
# Check balance
agentvault wallet balance

# Request from faucet (testnet only)
agentvault wallet faucet

# Purchase cycles
agentvault wallet purchase --amount 1000000000000
```

### Transaction Failed

```bash
# Check transaction queue
agentvault wallet queue

# Retry failed transaction
agentwallet wallet retry <tx-id>

# View error details
agentvault wallet history <tx-id> --details
```

### Hardware Wallet Issues

```bash
# Reconnect hardware wallet
agentvault wallet reconnect --hardware

# Check firmware
agentvault wallet check --hardware

# Reset connection
agentvault wallet disconnect --hardware
```

## Advanced Features

### Multi-Signature Wallets

Multi-signature wallets are not supported. For changes that need sign-off
from several people, `agentvault approve` tracks approval requests and a
signer quorum locally. It is not cryptographic multisig: signer names are not
authenticated, and no transfer waits for an approval.

### Derivation Paths

Standard derivation paths for BIP-39/44:

```bash
# View derivation path
agentvault wallet info <wallet-id> --show-derivation

# Change derivation path
agentvault wallet set-derivation <wallet-id> --path "m/44'/223'/0'/0"
```

### Custom Networks

Add custom blockchain networks:

```bash
# Add network
agentvault network add --name custom --rpc https://custom-rpc.com

# Use network
agentvault deploy --network custom
```

## Integration

### ICP Canister Funding

```bash
# Top-up canister from wallet
agentvault wallet top-up <canister-id> --wallet <wallet-id>

# Auto-refill configuration
agentvault wallet configure <wallet-id> --auto-refill --threshold 100T
```

### DApp Integration

Connect wallet to Web3 DApps:

```bash
# Inject wallet into browser
agentvault wallet inject --browser chrome

# Use with DApp
agentvault wallet dapp-sign <url>
```

## Next Steps

- [ ] Read [Deployment Guide](./deployment.md) for canister funding
- [ ] Read [Troubleshooting](./troubleshooting.md) for common issues
- [ ] Explore [Security Documentation](../security/overview.md)
