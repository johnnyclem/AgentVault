/**
 * SmallChat ToolClass Definitions for AgentVault Canister Operations
 *
 * Maps AgentVault's Candid service interface to SmallChat ToolClass hierarchy.
 * Each canister operation becomes a SmallChat tool with a selector, enabling
 * intent-based dispatch, superclass fallback, and compact representation.
 *
 * Hierarchy:
 *   BaseTools
 *   ├── CanisterLifecycleTools  (bootstrap, freeze, unlock, revive)
 *   ├── WalletTools             (register, deregister, list, update status)
 *   │   └── TransactionTools    (queue, sign, complete, fail, retry, schedule)
 *   ├── SecretTools             (store, get, list, delete encrypted secrets)
 *   └── VetKeysTools            (init shares, derive key, verify sig)
 */

// ---------------------------------------------------------------------------
// Tool parameter schemas (derived from canister/agent.did)
// ---------------------------------------------------------------------------

export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
  enum?: string[];
}

export interface SmallChatToolDefinition {
  selector: string;
  candidMethod: string;
  description: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  parameters: Record<string, ToolParameterSchema>;
  requiresMfa?: boolean;
}

export type ToolCategory =
  | 'lifecycle'
  | 'wallet'
  | 'transaction'
  | 'secret'
  | 'vetkeys'
  | 'query';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ---------------------------------------------------------------------------
// ToolClass hierarchy
// ---------------------------------------------------------------------------

export interface ToolClass {
  name: string;
  superclass?: string;
  tools: SmallChatToolDefinition[];
}

export const BASE_TOOLS: ToolClass = {
  name: 'BaseTools',
  tools: [
    {
      selector: 'getCanisterStatus',
      candidMethod: 'getCanisterStatus',
      description: 'Query canister running status, memory size, and cycle balance',
      category: 'query',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getMetrics',
      candidMethod: 'getMetrics',
      description: 'Query canister uptime, operation count, and last activity timestamp',
      category: 'query',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getSecurityStatus',
      candidMethod: 'getSecurityStatus',
      description: 'Query owner, frozen mode, bootstrap state, kill switch, and heap usage',
      category: 'query',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getHealthStatus',
      candidMethod: 'getHealthStatus',
      description: 'Query heartbeat health check state including consecutive timeouts',
      category: 'query',
      riskLevel: 'low',
      parameters: {},
    },
  ],
};

export const CANISTER_LIFECYCLE_TOOLS: ToolClass = {
  name: 'CanisterLifecycleTools',
  superclass: 'BaseTools',
  tools: [
    {
      selector: 'bootstrap',
      candidMethod: 'bootstrap',
      description: 'Initialize canister with agent config, setting owner to caller',
      category: 'lifecycle',
      riskLevel: 'critical',
      requiresMfa: true,
      parameters: {
        name: { type: 'string', required: true, description: 'Agent name' },
        agentType: { type: 'string', required: true, description: 'Agent type identifier' },
        version: { type: 'string', required: true, description: 'Agent version' },
      },
    },
    {
      selector: 'completeBootstrap',
      candidMethod: 'completeBootstrap',
      description: 'Freeze canister after bootstrap — blocks all writes until manual unlock',
      category: 'lifecycle',
      riskLevel: 'critical',
      requiresMfa: true,
      parameters: {},
    },
    {
      selector: 'freeze',
      candidMethod: 'freeze',
      description: 'Freeze canister — block all state mutations (owner only)',
      category: 'lifecycle',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {},
    },
    {
      selector: 'manualUnlock',
      candidMethod: 'manualUnlock',
      description: 'Unlock frozen canister to re-enable writes (owner only)',
      category: 'lifecycle',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {},
    },
    {
      selector: 'reviveCanister',
      candidMethod: 'reviveCanister',
      description: 'Reset health-check kill switch counters (owner only)',
      category: 'lifecycle',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {},
    },
    {
      selector: 'addAuthorizedPrincipal',
      candidMethod: 'addAuthorizedPrincipal',
      description: 'Add a principal to the authorized callers list (owner only)',
      category: 'lifecycle',
      riskLevel: 'critical',
      requiresMfa: true,
      parameters: {
        principal: { type: 'string', required: true, description: 'ICP principal ID to authorize' },
      },
    },
    {
      selector: 'removeAuthorizedPrincipal',
      candidMethod: 'removeAuthorizedPrincipal',
      description: 'Remove a principal from the authorized callers list (owner only)',
      category: 'lifecycle',
      riskLevel: 'critical',
      requiresMfa: true,
      parameters: {
        principal: { type: 'string', required: true, description: 'ICP principal ID to revoke' },
      },
    },
  ],
};

export const WALLET_TOOLS: ToolClass = {
  name: 'WalletTools',
  superclass: 'BaseTools',
  tools: [
    {
      selector: 'registerWallet',
      candidMethod: 'registerWallet',
      description: 'Register a new wallet for an agent',
      category: 'wallet',
      riskLevel: 'medium',
      parameters: {
        id: { type: 'string', required: true, description: 'Wallet identifier' },
        agentId: { type: 'string', required: true, description: 'Owning agent ID' },
        chain: { type: 'string', required: true, description: 'Blockchain (icp, eth, dot, sol)' },
        address: { type: 'string', required: true, description: 'On-chain address' },
      },
    },
    {
      selector: 'getWallet',
      candidMethod: 'getWallet',
      description: 'Get wallet details by ID',
      category: 'wallet',
      riskLevel: 'low',
      parameters: {
        walletId: { type: 'string', required: true, description: 'Wallet identifier' },
      },
    },
    {
      selector: 'listWallets',
      candidMethod: 'listWallets',
      description: 'List all wallets for an agent',
      category: 'wallet',
      riskLevel: 'low',
      parameters: {
        agentId: { type: 'string', required: true, description: 'Agent ID' },
      },
    },
    {
      selector: 'deregisterWallet',
      candidMethod: 'deregisterWallet',
      description: 'Remove a wallet registration',
      category: 'wallet',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {
        walletId: { type: 'string', required: true, description: 'Wallet identifier' },
      },
    },
    {
      selector: 'updateWalletStatus',
      candidMethod: 'updateWalletStatus',
      description: 'Change wallet status (active, inactive, revoked)',
      category: 'wallet',
      riskLevel: 'medium',
      parameters: {
        walletId: { type: 'string', required: true, description: 'Wallet identifier' },
        status: {
          type: 'string',
          required: true,
          description: 'New status',
          enum: ['active', 'inactive', 'revoked'],
        },
      },
    },
  ],
};

export const TRANSACTION_TOOLS: ToolClass = {
  name: 'TransactionTools',
  superclass: 'WalletTools',
  tools: [
    {
      selector: 'queueTransaction',
      candidMethod: 'queueTransaction',
      description: 'Queue a new transaction for processing',
      category: 'transaction',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {
        walletId: { type: 'string', required: true, description: 'Source wallet ID' },
        action: {
          type: 'string',
          required: true,
          description: 'Transaction type',
          enum: ['send_funds', 'sign_message', 'deploy_contract'],
        },
        parameters: {
          type: 'object',
          required: true,
          description: 'Key-value transaction parameters',
        },
        priority: {
          type: 'string',
          description: 'Priority level',
          enum: ['low', 'normal', 'high'],
        },
        threshold: {
          type: 'number',
          description: 'Required approval threshold',
        },
      },
    },
    {
      selector: 'markTransactionSigned',
      candidMethod: 'markTransactionSigned',
      description: 'Mark a queued transaction as signed',
      category: 'transaction',
      riskLevel: 'high',
      parameters: {
        transactionId: { type: 'string', required: true, description: 'Transaction ID' },
        signature: { type: 'string', required: true, description: 'Signature data' },
      },
    },
    {
      selector: 'markTransactionCompleted',
      candidMethod: 'markTransactionCompleted',
      description: 'Mark a transaction as completed with result',
      category: 'transaction',
      riskLevel: 'medium',
      parameters: {
        transactionId: { type: 'string', required: true, description: 'Transaction ID' },
        result: { type: 'string', required: true, description: 'Completion result' },
      },
    },
    {
      selector: 'markTransactionFailed',
      candidMethod: 'markTransactionFailed',
      description: 'Mark a transaction as failed with error message',
      category: 'transaction',
      riskLevel: 'medium',
      parameters: {
        transactionId: { type: 'string', required: true, description: 'Transaction ID' },
        error: { type: 'string', required: true, description: 'Error message' },
      },
    },
    {
      selector: 'retryTransaction',
      candidMethod: 'retryTransaction',
      description: 'Retry a failed transaction',
      category: 'transaction',
      riskLevel: 'high',
      parameters: {
        transactionId: { type: 'string', required: true, description: 'Transaction ID' },
      },
    },
    {
      selector: 'scheduleTransaction',
      candidMethod: 'scheduleTransaction',
      description: 'Schedule a transaction for future execution',
      category: 'transaction',
      riskLevel: 'high',
      parameters: {
        transactionId: { type: 'string', required: true, description: 'Transaction ID' },
        executeAt: { type: 'number', required: true, description: 'Execution timestamp (ns)' },
      },
    },
    {
      selector: 'getQueuedTransactions',
      candidMethod: 'getQueuedTransactions',
      description: 'List all queued transactions',
      category: 'transaction',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getPendingTransactions',
      candidMethod: 'getPendingTransactions',
      description: 'List pending (unprocessed) transactions',
      category: 'transaction',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getTransactionQueueStats',
      candidMethod: 'getTransactionQueueStats',
      description: 'Get queue statistics (total, pending, signed, completed, failed)',
      category: 'transaction',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'clearCompletedTransactions',
      candidMethod: 'clearCompletedTransactions',
      description: 'Remove completed transactions from the queue',
      category: 'transaction',
      riskLevel: 'medium',
      parameters: {},
    },
  ],
};

export const SECRET_TOOLS: ToolClass = {
  name: 'SecretTools',
  superclass: 'BaseTools',
  tools: [
    {
      selector: 'storeEncryptedSecret',
      candidMethod: 'storeEncryptedSecret',
      description: 'Store an encrypted secret in the canister',
      category: 'secret',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {
        id: { type: 'string', required: true, description: 'Secret identifier' },
        ciphertext: { type: 'string', required: true, description: 'Encrypted data (hex)' },
        iv: { type: 'string', required: true, description: 'Initialization vector (hex)' },
        tag: { type: 'string', required: true, description: 'Auth tag (hex)' },
        algorithm: {
          type: 'string',
          description: 'Encryption algorithm',
          enum: ['aes_256_gcm', 'chacha20_poly1305'],
        },
      },
    },
    {
      selector: 'getEncryptedSecret',
      candidMethod: 'getEncryptedSecret',
      description: 'Retrieve an encrypted secret by ID',
      category: 'secret',
      riskLevel: 'medium',
      parameters: {
        secretId: { type: 'string', required: true, description: 'Secret identifier' },
      },
    },
    {
      selector: 'listEncryptedSecrets',
      candidMethod: 'listEncryptedSecrets',
      description: 'List all encrypted secrets',
      category: 'secret',
      riskLevel: 'medium',
      parameters: {},
    },
    {
      selector: 'deleteEncryptedSecret',
      candidMethod: 'deleteEncryptedSecret',
      description: 'Delete an encrypted secret',
      category: 'secret',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {
        secretId: { type: 'string', required: true, description: 'Secret identifier' },
      },
    },
  ],
};

export const VETKEYS_TOOLS: ToolClass = {
  name: 'VetKeysTools',
  superclass: 'BaseTools',
  tools: [
    {
      selector: 'initializeThresholdShares',
      candidMethod: 'initializeThresholdShares',
      description: 'Register BLS threshold share public commitments for VetKeys',
      category: 'vetkeys',
      riskLevel: 'critical',
      requiresMfa: true,
      parameters: {
        masterPublicKey: { type: 'string', required: true, description: 'Master public key (hex)' },
        vssCommitments: {
          type: 'array',
          required: true,
          description: 'VSS commitment array',
          items: { type: 'string' },
        },
        shareCommitments: {
          type: 'array',
          required: true,
          description: 'Per-share commitment records',
          items: { type: 'object' },
        },
        groupCommitment: { type: 'string', required: true, description: 'Group commitment (hex)' },
        threshold: { type: 'number', required: true, description: 'Signing threshold (t-of-n)' },
        totalParties: { type: 'number', required: true, description: 'Total parties (n)' },
      },
    },
    {
      selector: 'deriveVetKeysKey',
      candidMethod: 'deriveVetKeysKey',
      description: 'Derive a threshold key for a given path and share index',
      category: 'vetkeys',
      riskLevel: 'high',
      requiresMfa: true,
      parameters: {
        derivationPath: { type: 'string', required: true, description: 'Key derivation path' },
        shareIndex: { type: 'number', required: true, description: 'Share participant index' },
      },
    },
    {
      selector: 'verifyThresholdSignature',
      candidMethod: 'verifyThresholdSignature',
      description: 'Verify a threshold signature against the registered shares',
      category: 'vetkeys',
      riskLevel: 'low',
      parameters: {
        message: { type: 'string', required: true, description: 'Signed message' },
        signature: { type: 'string', required: true, description: 'Threshold signature (hex)' },
      },
    },
    {
      selector: 'getVetKeysStatus',
      candidMethod: 'getVetKeysStatus',
      description: 'Query VetKeys initialization status and mode',
      category: 'vetkeys',
      riskLevel: 'low',
      parameters: {},
    },
    {
      selector: 'getShareHealthStatus',
      candidMethod: 'getShareHealthStatus',
      description: 'Query BLS threshold share health reports',
      category: 'vetkeys',
      riskLevel: 'low',
      parameters: {},
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry: all tool classes in hierarchy order
// ---------------------------------------------------------------------------

export const ALL_TOOL_CLASSES: ToolClass[] = [
  BASE_TOOLS,
  CANISTER_LIFECYCLE_TOOLS,
  WALLET_TOOLS,
  TRANSACTION_TOOLS,
  SECRET_TOOLS,
  VETKEYS_TOOLS,
];

/**
 * Flatten all tool definitions from all classes into a single map
 * keyed by selector string.
 */
export function getAllToolDefinitions(): Map<string, SmallChatToolDefinition> {
  const map = new Map<string, SmallChatToolDefinition>();
  for (const cls of ALL_TOOL_CLASSES) {
    for (const tool of cls.tools) {
      map.set(tool.selector, tool);
    }
  }
  return map;
}

/**
 * Get the superclass chain for a given ToolClass name.
 * Returns array from most specific to least specific (BaseTools last).
 */
export function getSuperclassChain(className: string): string[] {
  const chain: string[] = [className];
  let current = ALL_TOOL_CLASSES.find((c) => c.name === className);
  while (current?.superclass) {
    chain.push(current.superclass);
    current = ALL_TOOL_CLASSES.find((c) => c.name === current!.superclass);
  }
  return chain;
}

/**
 * Find the ToolClass that owns a given selector.
 */
export function findToolClassForSelector(selector: string): ToolClass | undefined {
  return ALL_TOOL_CLASSES.find((cls) => cls.tools.some((t) => t.selector === selector));
}

/**
 * Get all tools that require MFA confirmation.
 */
export function getMfaRequiredTools(): SmallChatToolDefinition[] {
  return ALL_TOOL_CLASSES.flatMap((cls) => cls.tools.filter((t) => t.requiresMfa));
}

/**
 * Get all tools at or above a given risk level.
 */
export function getToolsByMinRisk(minRisk: RiskLevel): SmallChatToolDefinition[] {
  const levels: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  const minIndex = levels.indexOf(minRisk);
  return ALL_TOOL_CLASSES.flatMap((cls) =>
    cls.tools.filter((t) => levels.indexOf(t.riskLevel) >= minIndex)
  );
}
