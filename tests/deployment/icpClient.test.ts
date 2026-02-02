import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  createICPClient,
  generateStubCanisterId,
  calculateWasmHash,
  validateWasmPath,
} from '../../src/deployment/icpClient.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('icpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateStubCanisterId', () => {
    it('should return a fixed canister ID for local development', () => {
      const id = generateStubCanisterId();

      // The stub returns a fixed ID for local development
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
      expect(id.includes('-')).toBe(true);
    });

    it('should return consistent ID', () => {
      const id1 = generateStubCanisterId();
      const id2 = generateStubCanisterId();

      // Stub returns the same ID each time
      expect(id1).toBe(id2);
    });
  });

  describe('validateWasmPath', () => {
    it('should return invalid for non-existent file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateWasmPath('/nonexistent/file.wasm');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return valid for existing file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = validateWasmPath('/path/to/valid.wasm');

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('calculateWasmHash', () => {
    it('should calculate base64 hash of WASM file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from([0x00, 0x61, 0x73, 0x6d]));

      const hash = calculateWasmHash('/path/to/file.wasm');

      expect(hash).toBeDefined();
      // Base64 encoding of the buffer
      expect(hash).toBe(Buffer.from([0x00, 0x61, 0x73, 0x6d]).toString('base64'));
    });
  });

  describe('ICPClient', () => {
    describe('constructor', () => {
      it('should create client with local network', () => {
        const client = createICPClient({ network: 'local' });

        expect(client.network).toBe('local');
        expect(client.getHost()).toBe('http://127.0.0.1:4943');
      });

      it('should create client with ic network', () => {
        const client = createICPClient({ network: 'ic' });

        expect(client.network).toBe('ic');
        expect(client.getHost()).toBe('https://ic0.app');
      });

      it('should use custom host if provided', () => {
        const client = createICPClient({
          network: 'local',
          host: 'http://custom:8000',
        });

        expect(client.getHost()).toBe('http://custom:8000');
      });
    });

    describe('checkConnection', () => {
      it('should return connected for ic network', async () => {
        const client = createICPClient({ network: 'ic' });

        const result = await client.checkConnection();

        expect(result.connected).toBe(true);
      });

      it('should return connected for local network', async () => {
        const client = createICPClient({ network: 'local' });

        const result = await client.checkConnection();

        expect(result.connected).toBe(true);
      });
    });

    describe('createCanister', () => {
      it('should return canister ID and cycles', async () => {
        const client = createICPClient({ network: 'local' });

        const result = await client.createCanister();

        expect(result.canisterId).toBeDefined();
        expect(result.canisterId.includes('-')).toBe(true);
        expect(typeof result.cyclesUsed).toBe('bigint');
      });
    });

    describe('installCode', () => {
      it('should install code successfully', async () => {
        vi.mocked(fs.readFileSync).mockReturnValue(
          Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
        );

        const client = createICPClient({ network: 'local' });

        const result = await client.installCode('test-canister-id', '/path/to/file.wasm');

        expect(result.success).toBe(true);
        expect(result.cyclesUsed).toBeGreaterThan(BigInt(0));
      });

      it('should throw on file read error', async () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => {
          throw new Error('File not found');
        });

        const client = createICPClient({ network: 'local' });

        await expect(
          client.installCode('test-canister-id', '/nonexistent.wasm')
        ).rejects.toThrow('Failed to install code');
      });
    });

    describe('getCanisterStatus', () => {
      it('should return canister status', async () => {
        const client = createICPClient({ network: 'local' });

        const status = await client.getCanisterStatus('test-canister-id');

        expect(status.status).toBe('running');
        expect(status.memorySize).toBeGreaterThan(BigInt(0));
        expect(status.cycles).toBeGreaterThan(BigInt(0));
      });
    });

    describe('deploy', () => {
      beforeEach(() => {
        vi.mocked(fs.readFileSync).mockReturnValue(
          Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
        );
      });

      it('should deploy new canister', async () => {
        const client = createICPClient({ network: 'local' });

        const result = await client.deploy('/path/to/file.wasm');

        expect(result.canisterId).toBeDefined();
        expect(result.isUpgrade).toBe(false);
        expect(typeof result.cyclesUsed).toBe('bigint');
        expect(result.wasmHash).toBeDefined();
      });

      it('should upgrade existing canister', async () => {
        const client = createICPClient({ network: 'local' });

        const result = await client.deploy('/path/to/file.wasm', 'existing-canister-id');

        expect(result.canisterId).toBe('existing-canister-id');
        expect(result.isUpgrade).toBe(true);
      });

      it('should throw on file read error', async () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => {
          throw new Error('File not found');
        });

        const client = createICPClient({ network: 'local' });

        await expect(client.deploy('/nonexistent.wasm')).rejects.toThrow();
      });
    });
  });
});
