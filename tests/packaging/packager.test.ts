import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as esbuild from 'esbuild';
import { packageAgent, validateAgent, getPackageSummary } from '../../src/packaging/packager.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock esbuild
vi.mock('esbuild', () => ({
  build: vi.fn(),
}));

describe('packager', () => {
  const mockAgentCode = 'console.log("hello");';

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock esbuild to return bundled code
    vi.mocked(esbuild.build).mockResolvedValue({
      errors: [],
      warnings: [],
      outputFiles: [{
        text: mockAgentCode,
        path: '/path/to/agent/index.ts',
        contents: new Uint8Array(),
        hash: ''
      }],
      metafile: undefined,
      mangleCache: undefined,
    });
  });

  describe('validateAgent', () => {
    it('should return valid for existing directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return error for non-existent path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateAgent('/nonexistent/path');

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.code).toBe('INVALID_SOURCE_PATH');
    });

    it('should warn when no entry point detected', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        // Only return true for the base path, not for entry point checks
        return String(p) === '/path/to/agent' || String(p).endsWith('/path/to/agent');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('entry point'))).toBe(true);
    });

    it('should warn when agent type is generic', () => {
      // Mock so that only the base path exists, not any agent-specific config files
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        // Return true only for the base directory, not for any config files
        return pathStr === '/path/to/agent' || pathStr.endsWith('/to/agent');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const result = validateAgent('/path/to/agent');

      expect(result.warnings.some((w) => w.includes('generic'))).toBe(true);
    });
  });

  describe('getPackageSummary', () => {
    it('should return config and validation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => false } as fs.Stats);

      const summary = getPackageSummary('/path/to/my-agent');

      expect(summary.config).toBeDefined();
      expect(summary.config.name).toBe('my-agent');
      expect(summary.validation).toBeDefined();
      expect(summary.validation.valid).toBe(true);
    });

    it('should include validation errors in summary', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const summary = getPackageSummary('/nonexistent/path');

      expect(summary.validation.valid).toBe(false);
      expect(summary.validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('packageAgent', () => {
    it('should throw when validation fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(packageAgent({ sourcePath: '/nonexistent/path' })).rejects.toThrow(
        'Validation failed'
      );
    });

    it('should skip validation when skipValidation is true', async () => {
      // Mock to simulate:
      // - source path exists and is a directory
      // - entry point exists
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        return pathStr.includes('/valid/path') || pathStr.includes('dist') || pathStr.includes('index.ts');
      });
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true, isFile: () => true } as fs.Stats);

      const result = await packageAgent({ sourcePath: '/valid/path', skipValidation: true });

      expect(result).toBeDefined();
      expect(result.config).toBeDefined();
    });

    it('should use default output directory when not specified', async () => {
      // Mock for complete packaging flow
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        // Simulate: directory exists, entry point exists
        return pathStr.includes('/path/to/agent') || pathStr.includes('index.ts');
      });
      vi.mocked(fs.statSync).mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.includes('index.ts')) {
          return { isDirectory: () => false, isFile: () => true } as fs.Stats;
        }
        return { isDirectory: () => true, isFile: () => false } as fs.Stats;
      });

      const result = await packageAgent({ sourcePath: '/path/to/agent' });

      expect(result.wasmPath).toContain('dist');
    });

    it('should use specified output directory', async () => {
      // Mock for complete packaging flow
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        return pathStr.includes('/path/to/agent') ||
               pathStr.includes('index.ts') ||
               pathStr.includes('/custom/output');
      });
      vi.mocked(fs.statSync).mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.includes('index.ts')) {
          return { isDirectory: () => false, isFile: () => true } as fs.Stats;
        }
        return { isDirectory: () => true, isFile: () => false } as fs.Stats;
      });

      const result = await packageAgent({
        sourcePath: '/path/to/agent',
        outputPath: '/custom/output',
      });

      expect(result.wasmPath).toContain('/custom/output');
    });

    it('should return package result with all required fields', async () => {
      // Mock for complete packaging flow
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const pathStr = String(p);
        return pathStr.includes('/path/to/agent') || pathStr.includes('index.ts');
      });
      vi.mocked(fs.statSync).mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.includes('index.ts')) {
          return { isDirectory: () => false, isFile: () => true } as fs.Stats;
        }
        return { isDirectory: () => true, isFile: () => false } as fs.Stats;
      });

      const result = await packageAgent({ sourcePath: '/path/to/agent' });

      expect(result.config).toBeDefined();
      expect(result.wasmPath).toBeDefined();
      expect(result.watPath).toBeDefined();
      expect(result.statePath).toBeDefined();
      expect(result.wasmSize).toBeGreaterThan(0);
      expect(result.timestamp).toBeInstanceOf(Date);
    });
  });
});
