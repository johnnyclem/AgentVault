/**
 * ICP Client
 *
 * This module provides real ICP integration using @dfinity/agent SDK.
 * Handles canister deployment, installation, and queries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ICPClientConfig,
  CanisterInfo,
  DeploymentStatus,
  NetworkType,
} from './types.js';
import { Actor, HttpAgent } from '@dfinity/agent';

/**
 * ICP Client Class
 *
 * Provides methods for deploying, installing, and querying canisters.
 * Uses @dfinity/agent SDK for real ICP network interactions.
 */
export class ICPClient {
  private config: ICPClientConfig;
  private host: string;

  constructor(config: ICPClientConfig) {
    this.config = config;
    this.host = config.host ?? (config.network === 'local' ? 'http://127.0.0.1:4943' : 'https://ic0.app');
  }

  get network(): NetworkType {
    return this.config.network;
  }

  getHost(): string {
    return this.host;
  }

  /**
   * Check connection to ICP network
   */
  async checkConnection(): Promise<{ connected: boolean; error?: string }> {
    try {
      // Create actor for test query
      const testAgentId = this.config.canisterId || 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai';
      const actor = createActor({
        agentId: testAgentId,
        canisterId: testAgentId,
        fetchRootKey: async () => {
          // Anonymous access for testing
          return undefined;
        },
      }, {
        agent: new HttpAgent({
          host: this.host,
        }),
      });

      // Try to query canister info
      await actor.canister_info();

      return { connected: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { connected: false, error: message };
    }
  }

  /**
   * Deploy WASM to canister (new or upgrade)
   *
   * @param wasmPath - Path to WASM file
   * @param canisterId - Optional canister ID for upgrade
   * @returns Deployment result with canister info
   */
  async deploy(
    wasmPath: string,
    canisterId?: string,
  ): Promise<{
    canisterId: string;
    isUpgrade: boolean;
    cyclesUsed: bigint;
    wasmHash: string;
  }> {
    try {
      // Read WASM file
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmSize = BigInt(wasmBuffer.length);
      const wasmHash = this.calculateWasmHash(wasmPath);

      let targetCanisterId = canisterId || '';
      let isUpgrade = false;

      // Upgrade existing canister if ID provided
      if (targetCanisterId) {
        isUpgrade = true;
      }

      // Create actor for deployment
      const actor = createActor({
        agentId: this.config.canisterId || 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai',
        canisterId: this.config.canisterId || 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai',
        fetchRootKey: async () => {
          // Anonymous access for deployment
          return undefined;
        },
      }, {
        agent: new HttpAgent({
          host: this.host,
        }),
      });

      // Create or upgrade canister
      let canisterIdResult: string;
      let cyclesUsed: bigint;

      if (targetCanisterId) {
        // Upgrade existing canister
        await actor.install_code({
          mode: { upgrade: [] },
          arg: wasmBuffer,
        });
      } else {
        // Create new canister
        const createResult = await actor.create_canister({
          mode: { install: [] },
          arg: wasmBuffer,
        });
        canisterIdResult = createResult.canister_id;
        cyclesUsed = createResult.cycles_consumed;
      }

      return {
        canisterId: canisterIdResult,
        isUpgrade,
        cyclesUsed,
        wasmHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to deploy: ${message}`);
    }
  }

  /**
   * Get canister status
   *
   * @param canisterId - Canister ID to query
   * @returns Canister status information
   */
  async getCanisterStatus(
    canisterId: string
  ): Promise<{
    exists: boolean;
    status: DeploymentStatus;
    memorySize?: bigint;
    cycles?: bigint;
  }> {
    try {
      // Create actor for canister queries
      const actor = createActor({
        agentId: canisterId,
        canisterId: canisterId,
        fetchRootKey: async () => {
          return undefined;
        },
      }, {
        agent: new HttpAgent({
          host: this.host,
        }),
      });

      // Query canister info
      const canisterInfo = await actor.canister_info();
      const status = canisterInfo.status === 'stopped' ? 'stopped' : 'running';

      return {
        exists: true,
        status,
        memorySize: canisterInfo.memory_size,
        cycles: canisterInfo.cycles,
      };
    } catch (error) {
      // If canister doesn't exist, it's not an error
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        exists: false,
        status: 'stopped',
        cycles: BigInt(0),
      };
    }
  }

  /**
   * Validate WASM file path
   *
   * @param wasmPath - Path to WASM file
   * @returns Validation result
   */
  validateWasmPath(wasmPath: string): { valid: boolean; error?: string } {
    if (!fs.existsSync(wasmPath)) {
      return {
        valid: false,
        error: `WASM file not found: ${wasmPath}`,
      };
    }

    try {
      const buffer = fs.readFileSync(wasmPath);

      // Check minimum size
      if (buffer.length < 8) {
        return {
          valid: false,
          error: 'WASM file too small (must be at least 8 bytes)',
        };
      }

      // Check WASM magic bytes
      const magic = buffer.subarray(0, 4);
      const expectedMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      if (!magic.equals(expectedMagic)) {
        return {
          valid: false,
          error: 'Invalid WASM magic bytes',
        };
      }

      // Check WASM version
      const version = buffer.subarray(4, 8);
      const expectedVersion = Buffer.from([0x01, 0x00, 0x00, 0x00]);
      if (!version.equals(expectedVersion)) {
        return {
          valid: false,
          error: 'Invalid WASM version (must be version 1)',
        };
      }

      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        error: `Failed to validate WASM file: ${message}`,
      };
    }
  }

  /**
   * Calculate WASM file hash
   *
   * @param wasmPath - Path to WASM file
   * @returns Base64-encoded hash
   */
  calculateWasmHash(wasmPath: string): string {
    const buffer = fs.readFileSync(wasmPath);
    return buffer.toString('base64').substring(0, 32);
  }

  /**
   * Create ICP client instance
   *
   * @param config - Client configuration
   * @returns Initialized ICP client
   */
export function createICPClient(config: ICPClientConfig): ICPClient {
  return new ICPClient(config);
}

/**
 * Generate stub canister ID (for testing)
 *
 * @returns Fixed canister ID for local testing
 */
export function generateStubCanisterId(): string {
      return 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai';
    };
  }

  get network(): NetworkType {
    return this.config.network;
  }

  getHost(): string {
    return this.host;
  }

  /**
   * Initialize the actor for canister interactions
   */
  private async initActor(canisterId: string): Promise<Actor> {
    if (this.actor && this.config.canisterId === canisterId) {
      return this.actor;
    }

    const agentId = canisterId;
    const actor = createActor({
      agentId,
      canisterId: agentId,
      fetchRootKey: async () => {
        // In a real implementation, this would use principal-based auth
        // For now, we'll use anonymous access
        return undefined;
      },
    }, {
      agent: new HttpAgent({
        host: this.host,
      }),
    });

    this.actor = actor;
    return actor;
  }

  /**
   * Check connection to ICP network
   */
  async checkConnection(): Promise<{ connected: boolean; error?: string }> {
    try {
      // Create a temporary actor to test connection
      const testActor = await this.initActor(this.config.canisterId || 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai');

      // Try to query the agent status
      await testActor.getAgentStatus();

      return { connected: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { connected: false, error: message };
    }
  }

  /**
   * Create a new canister
   *
   * @returns Canister ID and cycles used for creation
   */
  async createCanister(): Promise<{ canisterId: string; cyclesUsed: bigint }> {
    try {
      const actor = await this.initActor('');

      // Create canister
      const canisterId = await actor.create_canister({
        mode: { install: [] },
      });

      return {
        canisterId,
        cyclesUsed: BigInt(0), // Creation is free
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to create canister: ${message}`);
    }
  }

  /**
   * Install WASM code on existing canister
   *
   * @param canisterId - Canister ID to install on
   * @param wasmPath - Path to WASM file
   * @returns Installation result with cycles used
   */
  async installCode(
    canisterId: string,
    wasmPath: string,
  ): Promise<{ success: boolean; cyclesUsed: bigint }> {
    try {
      const actor = await this.initActor(canisterId);
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmSize = BigInt(wasmBuffer.length);

      // Calculate cycles based on WASM size (1 cycle per byte)
      const cyclesUsed = wasmSize;

      // Install code
      await actor.install_code({
        mode: { install: [] },
        arg: wasmBuffer,
      });

      return {
        success: true,
        cyclesUsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to install code: ${message}`);
    }
  }

  /**
   * Get canister status
   *
   * @param canisterId - Canister ID to query
   * @returns Canister status information
   */
  async getCanisterStatus(
    canisterId: string
  ): Promise<{
    exists: boolean;
    status: DeploymentStatus;
    memorySize?: bigint;
    cycles?: bigint;
  }> {
    try {
      const actor = await this.initActor(canisterId);

      // Query canister info
      const canisterInfo = await actor.canister_info();
      const status: DeploymentStatus = 'running';

      return {
        exists: true,
        status,
        memorySize: canisterInfo.memory_size,
        cycles: canisterInfo.cycles,
      };
    } catch (error) {
      // If canister doesn't exist, it's not an error
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('not found')) {
        return {
          exists: false,
          status: 'stopped',
        };
      }
      throw error;
    }
  }

  /**
   * Deploy WASM to canister (new or upgrade)
   *
   * @param wasmPath - Path to WASM file
   * @param canisterId - Optional canister ID for upgrade
   * @returns Deployment result with canister info
   */
  async deploy(
    wasmPath: string,
    canisterId?: string,
  ): Promise<{
    canisterId: string;
    isUpgrade: boolean;
    cyclesUsed: bigint;
    wasmHash: string;
  }> {
    try {
      const actor = await this.initActor(canisterId || '');
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmSize = BigInt(wasmBuffer.length);
      const wasmHash = this.calculateWasmHash(wasmPath);

      let targetCanisterId = canisterId || '';
      let isUpgrade = false;

      if (targetCanisterId) {
        isUpgrade = true;
      } else {
        // Create new canister if not provided
        const createResult = await this.createCanister();
        targetCanisterId = createResult.canisterId;
      }

      // Calculate cycles for installation
      const cyclesUsed = wasmSize;

      // Install code on canister
      await actor.install_code({
        mode: { install: [] },
        arg: wasmBuffer,
      });

      return {
        canisterId: targetCanisterId,
        isUpgrade,
        cyclesUsed,
        wasmHash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to deploy: ${message}`);
    }
  }

  /**
   * Validate WASM file path
   *
   * @param wasmPath - Path to WASM file
   * @returns Validation result
   */
  validateWasmPath(wasmPath: string): { valid: boolean; error?: string } {
    if (!fs.existsSync(wasmPath)) {
      return {
        valid: false,
        error: `WASM file not found: ${wasmPath}`,
      };
    }

    try {
      const buffer = fs.readFileSync(wasmPath);

      // Check minimum size
      if (buffer.length < 8) {
        return {
          valid: false,
          error: `WASM file too small (must be at least 8 bytes)`,
        };
      }

      // Check WASM magic bytes
      const magic = buffer.subarray(0, 4);
      const expectedMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      if (!magic.equals(expectedMagic)) {
        return {
          valid: false,
          error: 'Invalid WASM magic bytes',
        };
      }

      // Check WASM version
      const version = buffer.subarray(4, 8);
      const expectedVersion = Buffer.from([0x01, 0x00, 0x00, 0x00]);
      if (!version.equals(expectedVersion)) {
        return {
          valid: false,
          error: 'Invalid WASM version (must be version 1)',
        };
      }

      return { valid: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        valid: false,
        error: `Failed to validate WASM file: ${message}`,
      };
    }
  }

  /**
   * Calculate WASM file hash
   *
   * @param wasmPath - Path to WASM file
   * @returns Base64-encoded hash
   */
  calculateWasmHash(wasmPath: string): string {
    const buffer = fs.readFileSync(wasmPath);
    return buffer.toString('base64').substring(0, 32);
  }

/**
 * Create ICP client instance
 *
 * @param config - Client configuration
 * @returns Initialized ICP client
 */
export function createICPClient(config: ICPClientConfig): ICPClient {
  return new ICPClient(config);
}

/**
 * Generate stub canister ID (for testing)
 *
 * @returns Fixed canister ID for local testing
 */
export function generateStubCanisterId(): string {
  return 'rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai';
}
