import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { parseNemoClawConfig, findNemoClawConfigs } from '../../src/packaging/parsers/nemoclaw.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('../../src/debugging/debug-logger.js', () => ({
  debugLog: vi.fn(),
}));

describe('nemoclaw parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseNemoClawConfig', () => {
    it('should parse a valid nemoclaw.json config', async () => {
      const configContent = JSON.stringify({
        name: 'my-nemoclaw-agent',
        version: '1.0.0',
        description: 'Test NemoClaw agent',
        entryPoint: 'index.js',
        model: 'nemotron-mini',
        runtime: 'local',
        sandboxLevel: 'strict',
        privacyRouter: false,
        platform: 'dgx-spark',
        skills: ['code-review'],
        policies: {
          networkAccess: true,
          filesystemWrite: false,
          dataRetention: 'none',
        },
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('nemoclaw.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const config = await parseNemoClawConfig('/agent/path');

      expect(config.type).toBe('nemoclaw');
      expect(config.name).toBe('my-nemoclaw-agent');
      expect(config.model).toBe('nemotron-mini');
      expect(config.runtime).toBe('local');
      expect(config.sandboxLevel).toBe('strict');
      expect(config.privacyRouter).toBe(false);
      expect(config.platform).toBe('dgx-spark');
      expect(config.skills).toEqual(['code-review']);
      expect(config.policies?.networkAccess).toBe(true);
      expect(config.policies?.dataRetention).toBe('none');
    });

    it('should apply defaults for missing fields', async () => {
      const configContent = JSON.stringify({
        name: 'minimal-agent',
        version: '1.0.0',
        entryPoint: 'main.js',
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('nemoclaw.json') || String(p).endsWith('main.js');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const config = await parseNemoClawConfig('/agent/path');

      expect(config.model).toBe('nemotron-4-340b');
      expect(config.runtime).toBe('local');
      expect(config.sandboxLevel).toBe('standard');
      expect(config.privacyRouter).toBe(true);
      expect(config.platform).toBe('auto');
      expect(config.skills).toEqual([]);
      expect(config.policies?.networkAccess).toBe(false);
      expect(config.policies?.filesystemWrite).toBe(false);
      expect(config.policies?.dataRetention).toBe('session');
    });

    it('should throw when no config file is found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(parseNemoClawConfig('/agent/path')).rejects.toThrow(
        'No NemoClaw agent configuration found'
      );
    });

    it('should throw on invalid JSON', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('nemoclaw.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

      await expect(parseNemoClawConfig('/agent/path')).rejects.toThrow(
        'Failed to parse NemoClaw config'
      );
    });

    it('should use default name when name is missing', async () => {
      const configContent = JSON.stringify({
        version: '1.0.0',
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('nemoclaw.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const config = await parseNemoClawConfig('/agent/path');
      expect(config.name).toBe('nemoclaw-agent');
    });

    it('should throw on invalid version format', async () => {
      const configContent = JSON.stringify({
        name: 'test-agent',
        version: 'bad-version',
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p).endsWith('nemoclaw.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      await expect(parseNemoClawConfig('/agent/path')).rejects.toThrow(
        'Invalid version format'
      );
    });
  });

  describe('findNemoClawConfigs', () => {
    it('should find nemoclaw config files recursively', () => {
      vi.mocked(fs.readdirSync).mockImplementation((dirPath) => {
        const dir = String(dirPath);
        if (dir.endsWith('/root')) {
          return [
            { name: 'nemoclaw.json', isFile: () => true, isDirectory: () => false },
            { name: 'subdir', isFile: () => false, isDirectory: () => true },
          ] as unknown as fs.Dirent[];
        }
        if (dir.endsWith('/subdir')) {
          return [
            { name: 'nemoclaw.config.json', isFile: () => true, isDirectory: () => false },
          ] as unknown as fs.Dirent[];
        }
        return [];
      });

      const configs = findNemoClawConfigs('/root');
      expect(configs).toHaveLength(2);
    });
  });
});
