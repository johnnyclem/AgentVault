# Security Best Practices

Recommendations for secure use of AgentVault.

## Secrets Management

### Do's

- Use environment variables for API keys and RPC URLs
- Store `.env` files in `.gitignore`
- Use dfx identity system for ICP authentication
- Create separate identities for different environments
- Backup mnemonics in secure, offline storage

### Don'ts

- Never commit `.env` files to version control
- Never hardcode private keys or API keys
- Never share mnemonics via messaging or email
- Never log sensitive data

### Environment Variables

```bash
# Create .env file
cat > .env << EOF
# ICP
ICP_MAINNET_URL=https://ic0.app

# Ethereum
ETHEREUM_RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
ETHERSCAN_API_KEY=YOUR_KEY

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Polkadot
POLKADOT_RPC_URL=wss://rpc.polkadot.io
EOF

# Add to .gitignore
echo ".env" >> .gitignore
echo ".env.*" >> .gitignore
```

## Wallet Security

### Key Generation

```bash
# Generate wallet with strong entropy
agentvault wallet create --chain ethereum

# Import with caution - clears clipboard after
agentvault wallet import --chain ethereum --mnemonic
```

### Backup Wallets

```bash
# Export encrypted backup
agentvault wallet export <wallet-id> --format json > wallet-backup.json

# Store backup securely (encrypted USB, offline storage)
```

### Hardware Wallets

For production use, consider:

- Ledger Nano S/X for Ethereum
- Polkadot.js extension for Polkadot
- Phantom with hardware wallet support for Solana

## Deployment Security

### Canister Controllers

```bash
# Check current controllers
dfx canister info <canister-id>

# Add controller (use with caution)
dfx canister update-settings --add-controller <principal>

# Remove controller
dfx canister update-settings --remove-controller <principal>
```

### Network Isolation

```bash
# Local development - isolated
agentvault deploy --network local

# Production - public network
agentvault deploy --network ic
```

### Cycles Management

```bash
# Monitor cycles regularly
agentvault cycles balance <canister-id>

# Set up alerts for low cycles
agentvault monitor --alert --webhook <url>
```

## Backup & Recovery

### Backup Schedule

| Frequency | Content | Storage |
|-----------|---------|---------|
| Pre-deploy | Canister state | Local |
| Daily | Configuration | Local + Arweave |
| Weekly | Full backup | Arweave |

### Backup Commands

```bash
# Pre-deployment backup
agentvault backup --canister-id <id>

# Export backup for offsite storage
agentvault backup export <agent-name> -o ./backups/

# Archive to Arweave
agentvault archive upload <backup-id>
```

### Recovery Drill

Regularly test recovery:

```bash
# 1. Fetch state
agentvault fetch --canister-id <id>

# 2. Verify state integrity
agentvault show --canister-id <id> --verify

# 3. Test rebuild
agentvault rebuild --canister-id <id> --dry-run
```

## Network Security

### Compromised-By-Default Threat Model

When operating automated trading agents, assume host and credential exposure is possible and layer controls accordingly:

- Treat API keys as short-lived credentials and automate weekly rotation for exchange keys (for example, Binance).
- Restrict exchange API keys with provider-side IP whitelists so leaked keys are not useful from arbitrary networks.
- Route bot traffic through a dedicated VPS egress IP and enforce host firewall rules to allow only required outbound destinations.
- Run skill/tool execution with least privilege. OpenClaw skills should run without root and with filesystem writes constrained to `/tmp` only.

### HTTPS Only

- Always use HTTPS for mainnet
- Local development uses HTTP (isolated)
- Never override certificate validation

### Rate Limiting

```bash
# Avoid rate limits with delays
agentvault deploy --timeout 60000
```

### API Security

```bash
# Use API keys securely
export ETHERSCAN_API_KEY=$(cat ~/.secrets/etherscan-key)

# Rotate keys regularly (weekly for exchange trading keys)
```

### Exchange API Hardening (Binance Example)

```bash
# Example: run trading worker from hardened VPS only
ufw default deny outgoing
ufw allow out to any port 443 proto tcp

# Store and rotate Binance keys weekly
export BINANCE_API_KEY=$(cat ~/.secrets/binance-key)
export BINANCE_API_SECRET=$(cat ~/.secrets/binance-secret)
```

- Enable Binance API key IP restriction and set it to your VPS egress IP.
- Disable withdrawal permissions for trading-only keys.
- Use separate keys per environment (dev/staging/prod) and rotate each on a weekly cadence.

### OpenClaw Skill Sandboxing

```bash
# Run skill in isolated user namespace/container (example)
# - no root
# - writable path limited to /tmp
docker run --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev --user 65534:65534 <image>
```

- Do not run OpenClaw skills as root.
- Mount project directories read-only when possible.
- Deny writes outside `/tmp` and drop unnecessary Linux capabilities.

## Monitoring & Alerting

### Health Checks

```bash
# Enable continuous monitoring
agentvault monitor --canister-id <id> --interval 60000 --alert
```

### Alert Webhooks

```bash
# Configure webhook for alerts
agentvault monitor --webhook https://hooks.example.com/agentvault
```

### Log Analysis

```bash
# Monitor for errors
agentvault logs --canister-id <id> --level error --follow
```

## Operational Security Checklist

### Before Deployment

- [ ] Verify network (local vs production)
- [ ] Check canister controllers
- [ ] Ensure sufficient cycles
- [ ] Create backup
- [ ] Review configuration

### After Deployment

- [ ] Verify health check passes
- [ ] Monitor logs for errors
- [ ] Document canister ID
- [ ] Set up monitoring alerts
- [ ] Schedule regular backups

### Regular Maintenance

- [ ] Rotate exchange API keys (weekly)
- [ ] Review access logs (weekly)
- [ ] Test recovery procedures (monthly)
- [ ] Update dependencies (as needed)
- [ ] Review security audit findings

## Security Contacts

- Report vulnerabilities privately to maintainers
- See [Security Audit](../dev/SECURITY_AUDIT.md) for known issues
- See [Troubleshooting](../user/troubleshooting.md) for common issues
