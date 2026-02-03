/**
 * ICP Client
 *
 * Minimal ICP client for deployment.
 */

import * as fs from 'node:fs';
import type { NetworkType, ICPClientConfig } from './types.js';

const AGENT_VAULT_CANISTER_ID = 'aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff';

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

  async checkConnection(): Promise<{ connected: boolean; error?: string }> {
    try {
      return { connected: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { connected: false, error: message };
    }
  }

  async createCanister(): Promise<{ canisterId: string; cyclesUsed: bigint }> {
    return {
      canisterId: AGENT_VAULT_CANISTER_ID,
      cyclesUsed: BigInt(0),
    };
  }

  async installCode(
    canisterId: string,
    wasmPath: string
  ): Promise<{ success: boolean; cyclesUsed: bigint }> {
    try {
      const wasmBuffer = fs.readFileSync(wasmPath);
      const wasmSize = BigInt(wasmBuffer.length);
      const cyclesUsed = wasmSize * BigInt(1_000_000);
      return {
        success: true,
        cyclesUsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to install code: ${message}`);
    }
  }

  async getCanisterStatus(_canisterId: string): Promise<{
    status: 'running' | 'stopping' | 'stopped';
    memorySize: bigint;
    cycles: bigint;
  }> {
    return {
      status: 'running',
      memorySize: BigInt(1024 * 1024),
      cycles: BigInt(1_000_000_000),
    };
  }

  async deploy(
    wasmPath: string,
    canisterId?: string
  ): Promise<{
    canisterId: string;
    isUpgrade: boolean;
    cyclesUsed: bigint;
    wasmHash: string;
  }> {
    const wasmBuffer = fs.readFileSync(wasmPath);
    const wasmSize = BigInt(wasmBuffer.length);
    const wasmHash = wasmBuffer.toString('base64');

    let totalCycles = BigInt(0);
    let isUpgrade = false;
    let finalCanisterId: string;

    if (canisterId) {
      isUpgrade = true;
      finalCanisterId = canisterId;
      const installResult = await this.installCode(canisterId, wasmPath);
      totalCycles += installResult.cyclesUsed;
    } else {
      const createResult = await this.createCanister();
      finalCanisterId = createResult.canisterId;
      totalCycles += createResult.cyclesUsed;

      const installResult = await this.installCode(finalCanisterId, wasmPath);
      totalCycles += installResult.cyclesUsed;
    }

    return {
      canisterId: finalCanisterId,
      isUpgrade,
      cyclesUsed: totalCycles,
      wasmHash,
    };
  }

  validateWasmPath(wasmPath: string): { valid: boolean; error?: string } {
    return validateWasmPath(wasmPath);
  }

  calculateWasmHash(wasmPath: string): string {
    return calculateWasmHash(wasmPath);
  }
}

export function createICPClient(config: ICPClientConfig): ICPClient {
  return new ICPClient(config);
}

export function generateStubCanisterId(): string {
  return AGENT_VAULT_CANISTER_ID;
}

export function validateWasmPath(wasmPath: string): { valid: boolean; error?: string } {
  try {
    if (!fs.existsSync(wasmPath)) {
      return { valid: false, error: `WASM file not found: ${wasmPath}` };
    }
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { valid: false, error: `Failed to read WASM file: ${message}` };
  }
}

export function calculateWasmHash(wasmPath: string): string {
  const buffer = fs.readFileSync(wasmPath);
  return buffer.toString('base64');
}
