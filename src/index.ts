/**
 * AgentVault - Persistent On-Chain AI Agent Platform
 *
 * Sovereign, Reconstructible, Autonomous
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Resolve the package version from package.json so the CLI and library
 * always report the published version. Works both from source (src/) and
 * from the compiled output (dist/src/).
 */
function loadVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string };
      if (pkg.name === 'agentvault' && pkg.version) {
        return pkg.version;
      }
    } catch {
      // try the next candidate path
    }
  }
  return '0.0.0';
}

export const VERSION = loadVersion();

export interface AgentVaultConfig {
  name: string;
  version: string;
}

export function createConfig(name: string): AgentVaultConfig {
  return {
    name,
    version: VERSION,
  };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`AgentVault v${VERSION}`);
  console.log('Persistent On-Chain AI Agent Platform');
}
