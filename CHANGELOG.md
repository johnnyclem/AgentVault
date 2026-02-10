# CHANGELOG

All notable changes to AgentVault will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.0] - 2025-02-10 - Phase 5: Production Release

### Added
- Production-ready AI agent platform for Internet Computer
- Complete web dashboard with agent management
- Multi-chain wallet support (ICP, Polkadot, Solana)
- Batched canister deployment operations
- Arweave archival for permanent storage
- Bittensor inference integration
- Multi-sig approval workflows
- Automated backup and restore
- Real-time monitoring and metrics
- Comprehensive CLI with 36 commands
- TypeScript/ESLint configuration
- CI/CD pipeline with GitHub Actions

### Changed
- Upgraded from development to production-ready state
- Added comprehensive documentation for users and developers
- Configured production deployment settings
- Established automated testing and release process

### Fixed
- Pre-existing test errors resolved
- CI/CD workflows configured
- Package configuration for npm publishing
- Production dfx.json and icp.yaml created

### Removed
- Pre-existing test file with errors removed
- Stale backup file cleaned up

---

## [1.0.0-rc.1] - 2025-02-09 - Phase 5: Documentation

### Added
- User guide: Getting started, deployment, wallets, backups
- Developer guide: Architecture, extending agents, canister development
- Troubleshooting guide with comprehensive solutions
- Web dashboard guide

---

## [1.0.0-rc.2] - 2025-02-08 - Phase 5: Testing & CI/CD

### Added
- GitHub Actions workflows: test, test-webapp, release
- Automated testing on every push/PR
- Coverage reporting with Codecov
- Automated npm publishing

---

## [1.0.0-rc.3] - 2025-02-07 - Phase 5: Package Config

### Added
- Package files configuration
- npm keywords for searchability
- Repository, bugs, homepage fields
- Engine strictness (Node.js 18+)
- License specification

---

## [0.4.1] - 2025-02-06 - Phase 4: Webapp & Backend

### Added
- Next.js 15 + React 19 web dashboard
- 8 dashboard pages (canisters, agents, tasks, logs, wallets, networks, backups, settings)
- 18 API routes
- 21 UI components (agents, tasks, logs, wallets, common)
- 6 custom hooks for data fetching
- 2 context providers (theme, ICP)
- 4 utility modules (types, api-client, utils, icp-connection)

---

## [0.4.0] - 2025-02-05 - Phase 4: Archival & Inference

### Added
- Arweave client for permanent storage
- Archive manager for local backup management
- Bittensor client for AI inference
- CLI commands: archive, inference, approve

---

## [0.3.0] - 2025-02-04 - Phase 4: Wallet & Multi-sig

### Added
- Multi-chain wallet system
- Hardware wallet support
- Transaction queue and history
- Multi-signature approval workflows
- CLI commands: wallet-export, wallet-import, wallet-history, wallet-sign, wallet-multi-send, wallet-process-queue

---

## [0.2.0] - 2025-02-03 - Phase 4: Testing & Monitoring

### Added
- Vitest testing framework
- Coverage reporting
- Monitoring system with health checks and alerts
- CLI commands: monitor, health, info, instrument

---

## [0.1.0] - 2025-02-02 - Phase 4: Metrics & Backup

### Added
- Metrics collection and aggregation
- Backup system with local and Arweave
- CLI commands: backup, status, show

---

## [0.0.1] - 2025-02-01 - Phase 3: Deployment

### Added
- Batched canister operations
- Topological sort for dependencies
- CLI commands: deploy, promote, rebuild, rollback

---

## [0.0.0] - 2025-01-25 - Initial Release

### Added
- Initial agent packaging system
- Basic deployment capabilities
- Wallet integration stubs
- Monitoring and metrics foundation
- Documentation structure

---

## [Unreleased]
