import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import {
  WasmCompiler,
  compileAgentToWasm,
  validateWasmBinary,
  getSupportedTargets,
  isTargetFullySupported,
} from '../../src/packaging/wasm-compiler.js';
import type { AgentConfig } from '../../src/packaging/types.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock esbuild
vi.mock('esbuild', () => ({
  build: vi.fn(),
}));

describe('WasmCompiler', () => {
  const mockConfig: AgentConfig = {
    name: 'test-agent',
    type: 'clawdbot',
    sourcePath: '/path/to/agent',
    entryPoint: 'index.ts',
    version: '1.0.0',
  };

  const mockAgentCode = 'console.log("hello");';

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock entry point file existence
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return (
        String(path).includes('/path/to/agent/index.ts') || String(path) === '/output/dir'
      );
    });
    // Mock entry point file content
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (String(path).includes('/path/to/agent/index.ts')) {
        return mockAgentCode;
      }
      return Buffer.from([]);
    });
    // Mock esbuild to return bundled code
    vi.mocked(esbuild.build).mockResolvedValue({
      errors: [],
      warnings: [],
      outputFiles: [
        {
          text: mockAgentCode,
          path: '/path/to/agent/index.ts',
          contents: new Uint8Array(),
          hash: '',
        },
      ],
      metafile: undefined,
      mangleCache: undefined,
    });
  });

  describe('constructor', () => {
    it('should create compiler with default options', () => {
      const compiler = new WasmCompiler();
      expect(compiler).toBeInstanceOf(WasmCompiler);
    });

    it('should create compiler with custom options', () => {
      const compiler = new WasmCompiler({
        target: 'motoko',
        optimize: true,
        optimizationLevel: 2,
      });
      expect(compiler).toBeInstanceOf(WasmCompiler);
    });
  });

  describe('compile - JavaScript target', () => {
    it('should compile JavaScript source to WASM', async () => {
      const compiler = new WasmCompiler({ target: 'javascript' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary).toBeInstanceOf(Buffer);
      expect(result.watText).toContain('(module');
      expect(result.sourceBundle).toBe(mockAgentCode);
      expect(result.metadata.target).toBe('javascript');
      expect(result.metadata.isStub).toBe(false);
    });

    it('should generate valid WASM magic bytes', async () => {
      const compiler = new WasmCompiler({ target: 'javascript' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary[0]).toBe(0x00);
      expect(result.wasmBinary[1]).toBe(0x61);
      expect(result.wasmBinary[2]).toBe(0x73);
      expect(result.wasmBinary[3]).toBe(0x6d);
    });

    it('should generate WASM version 1', async () => {
      const compiler = new WasmCompiler({ target: 'javascript' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary[4]).toBe(0x01);
      expect(result.wasmBinary[5]).toBe(0x00);
      expect(result.wasmBinary[6]).toBe(0x00);
      expect(result.wasmBinary[7]).toBe(0x00);
    });

    it('should include agent name in WASM binary', async () => {
      const compiler = new WasmCompiler({ target: 'javascript' });
      const result = await compiler.compile(mockConfig);

      const wasmString = result.wasmBinary.toString('utf-8');
      expect(wasmString).toContain('test-agent');
    });

    it('should include expected exports in metadata', async () => {
      const compiler = new WasmCompiler({ target: 'javascript' });
      const result = await compiler.compile(mockConfig);

      expect(result.metadata.exports).toContain('init');
      expect(result.metadata.exports).toContain('step');
      expect(result.metadata.exports).toContain('get_state_ptr');
      expect(result.metadata.exports).toContain('get_state_size');
      expect(result.metadata.exports).toContain('memory');
    });

    it('should throw when entry point is missing', async () => {
      const configNoEntry = { ...mockConfig, entryPoint: undefined };
      const compiler = new WasmCompiler({ target: 'javascript' });

      await expect(compiler.compile(configNoEntry)).rejects.toThrow(
        'No entry point found'
      );
    });

    it('should throw when entry point file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const compiler = new WasmCompiler({ target: 'javascript' });

      await expect(compiler.compile(mockConfig)).rejects.toThrow(
        'Entry point not found'
      );
    });

    it('should throw when esbuild fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(esbuild.build).mockResolvedValue({
        errors: [
          {
            text: 'Build error',
            location: null,
            notes: [],
            id: '',
            pluginName: '',
            detail: undefined,
          },
        ],
        warnings: [],
        outputFiles: [],
        metafile: undefined,
        mangleCache: undefined,
      });

      const compiler = new WasmCompiler({ target: 'javascript' });

      await expect(compiler.compile(mockConfig)).rejects.toThrow('Bundle failed');
    });
  });

  describe('compile - Motoko target (stub)', () => {
    it('should generate stub WASM for Motoko', async () => {
      const compiler = new WasmCompiler({ target: 'motoko' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary).toBeInstanceOf(Buffer);
      expect(result.watText).toContain('(module');
      expect(result.watText).toContain('motoko');
      expect(result.metadata.target).toBe('motoko');
      expect(result.metadata.isStub).toBe(true);
    });

    it('should not include source bundle for stub', async () => {
      const compiler = new WasmCompiler({ target: 'motoko' });
      const result = await compiler.compile(mockConfig);

      expect(result.sourceBundle).toBeUndefined();
    });

    it('should include stub marker in WASM binary', async () => {
      const compiler = new WasmCompiler({ target: 'motoko' });
      const result = await compiler.compile(mockConfig);

      const wasmString = result.wasmBinary.toString('utf-8');
      expect(wasmString).toContain('agentvault-stub');
    });
  });

  describe('compile - Rust target (stub)', () => {
    it('should generate stub WASM for Rust', async () => {
      const compiler = new WasmCompiler({ target: 'rust' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary).toBeInstanceOf(Buffer);
      expect(result.watText).toContain('rust');
      expect(result.metadata.target).toBe('rust');
      expect(result.metadata.isStub).toBe(true);
    });
  });

  describe('compile - AssemblyScript target (stub)', () => {
    it('should generate stub WASM for AssemblyScript', async () => {
      const compiler = new WasmCompiler({ target: 'assemblyscript' });
      const result = await compiler.compile(mockConfig);

      expect(result.wasmBinary).toBeInstanceOf(Buffer);
      expect(result.watText).toContain('assemblyscript');
      expect(result.metadata.target).toBe('assemblyscript');
      expect(result.metadata.isStub).toBe(true);
    });
  });

  describe('compile with custom memory config', () => {
    it('should use custom memory configuration', async () => {
      const compiler = new WasmCompiler({
        target: 'javascript',
        memory: {
          initial: 4,
          maximum: 32,
          shared: false,
        },
      });
      const result = await compiler.compile(mockConfig);

      expect(result.metadata.memory.initial).toBe(4);
      expect(result.metadata.memory.maximum).toBe(32);
    });
  });
});

describe('compileAgentToWasm', () => {
  const mockConfig: AgentConfig = {
    name: 'test-agent',
    type: 'clawdbot',
    sourcePath: '/path/to/agent',
    entryPoint: 'index.ts',
    version: '1.0.0',
  };

  const mockAgentCode = 'console.log("hello");';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return (
        String(path).includes('/path/to/agent/index.ts') || String(path) === '/output/dir'
      );
    });
    vi.mocked(esbuild.build).mockResolvedValue({
      errors: [],
      warnings: [],
      outputFiles: [
        {
          text: mockAgentCode,
          path: '/path/to/agent/index.ts',
          contents: new Uint8Array(),
          hash: '',
        },
      ],
      metafile: undefined,
      mangleCache: undefined,
    });
  });

  it('should create output directory if it does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (String(path) === '/output/dir') return false;
      return String(path).includes('/path/to/agent/index.ts');
    });

    await compileAgentToWasm(mockConfig, '/output/dir');

    expect(fs.mkdirSync).toHaveBeenCalledWith('/output/dir', { recursive: true });
  });

  it('should write WASM file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await compileAgentToWasm(mockConfig, '/output/dir');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((call) => call[0] as string);

    expect(paths).toContain('/output/dir/test-agent.wasm');
  });

  it('should write WAT file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await compileAgentToWasm(mockConfig, '/output/dir');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((call) => call[0] as string);

    expect(paths).toContain('/output/dir/test-agent.wat');
  });

  it('should write state JSON file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await compileAgentToWasm(mockConfig, '/output/dir');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((call) => call[0] as string);

    expect(paths).toContain('/output/dir/test-agent.state.json');
  });

  it('should write bundle.js file for JavaScript target', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await compileAgentToWasm(mockConfig, '/output/dir', { target: 'javascript' });

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((call) => call[0] as string);

    expect(paths).toContain('/output/dir/test-agent.bundle.js');
  });

  it('should not write bundle.js for stub targets', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await compileAgentToWasm(mockConfig, '/output/dir', { target: 'motoko' });

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const paths = writeCalls.map((call) => call[0] as string);

    expect(paths).not.toContain('/output/dir/test-agent.bundle.js');
  });

  it('should return package result with correct paths', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await compileAgentToWasm(mockConfig, '/output/dir');

    expect(result.wasmPath).toBe('/output/dir/test-agent.wasm');
    expect(result.watPath).toBe('/output/dir/test-agent.wat');
    expect(result.statePath).toBe('/output/dir/test-agent.state.json');
  });

  it('should return package result with WASM size', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await compileAgentToWasm(mockConfig, '/output/dir');

    expect(result.wasmSize).toBeGreaterThan(0);
  });

  it('should return package result with timestamp', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await compileAgentToWasm(mockConfig, '/output/dir');

    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it('should return package result with config', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await compileAgentToWasm(mockConfig, '/output/dir');

    expect(result.config).toEqual(mockConfig);
  });
});

describe('validateWasmBinary', () => {
  it('should return true for valid WASM buffer', () => {
    const validWasm = Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d]), // magic
      Buffer.from([0x01, 0x00, 0x00, 0x00]), // version
    ]);

    expect(validateWasmBinary(validWasm)).toBe(true);
  });

  it('should return false for invalid magic bytes', () => {
    const invalidWasm = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);

    expect(validateWasmBinary(invalidWasm)).toBe(false);
  });

  it('should return false for invalid version', () => {
    const invalidVersion = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);

    expect(validateWasmBinary(invalidVersion)).toBe(false);
  });

  it('should return false for buffer too small', () => {
    const tooSmall = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

    expect(validateWasmBinary(tooSmall)).toBe(false);
  });
});

describe('getSupportedTargets', () => {
  it('should return all supported targets', () => {
    const targets = getSupportedTargets();

    expect(targets).toContain('javascript');
    expect(targets).toContain('motoko');
    expect(targets).toContain('rust');
    expect(targets).toContain('assemblyscript');
  });

  it('should return an array', () => {
    const targets = getSupportedTargets();

    expect(Array.isArray(targets)).toBe(true);
  });
});

describe('isTargetFullySupported', () => {
  it('should return true for javascript', () => {
    expect(isTargetFullySupported('javascript')).toBe(true);
  });

  it('should return false for motoko (stub)', () => {
    expect(isTargetFullySupported('motoko')).toBe(false);
  });

  it('should return false for rust (stub)', () => {
    expect(isTargetFullySupported('rust')).toBe(false);
  });

  it('should return false for assemblyscript (stub)', () => {
    expect(isTargetFullySupported('assemblyscript')).toBe(false);
  });
});
