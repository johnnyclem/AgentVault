import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureIcpManifest,
  resolveProjectRootForWasm,
  icpManifestPath,
  GENERATED_MARKER,
} from '../../src/deployment/icp-manifest.js';

describe('icp-manifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icp-manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveProjectRootForWasm', () => {
    it('should use the parent of a dist directory as project root', () => {
      const wasmPath = path.join(tmpDir, 'my-agent', 'dist', 'my-agent.wasm');
      expect(resolveProjectRootForWasm(wasmPath)).toBe(path.join(tmpDir, 'my-agent'));
    });

    it('should use the containing directory when not in dist', () => {
      const wasmPath = path.join(tmpDir, 'build', 'my-agent.wasm');
      expect(resolveProjectRootForWasm(wasmPath)).toBe(path.join(tmpDir, 'build'));
    });
  });

  describe('icpManifestPath', () => {
    it('should return icp.yaml in the project root', () => {
      expect(icpManifestPath(tmpDir)).toBe(path.join(tmpDir, 'icp.yaml'));
    });
  });

  describe('ensureIcpManifest', () => {
    it('should create a manifest when none exists', () => {
      const wasmPath = path.join(tmpDir, 'dist', 'my-agent.wasm');
      const result = ensureIcpManifest(tmpDir, 'my-agent', wasmPath);

      expect(result.action).toBe('created');
      expect(fs.existsSync(result.path)).toBe(true);

      const content = fs.readFileSync(result.path, 'utf-8');
      expect(content.startsWith(GENERATED_MARKER)).toBe(true);
      expect(content).toContain('name: my-agent');
      expect(content).toContain('cp "dist/my-agent.wasm" "$ICP_WASM_OUTPUT_PATH"');
    });

    it('should use forward slashes in the wasm path', () => {
      const wasmPath = path.join(tmpDir, 'dist', 'nested', 'my-agent.wasm');
      const result = ensureIcpManifest(tmpDir, 'my-agent', wasmPath);

      const content = fs.readFileSync(result.path, 'utf-8');
      expect(content).toContain('dist/nested/my-agent.wasm');
      expect(content).not.toContain('\\');
    });

    it('should update a previously generated manifest', () => {
      const wasmPath = path.join(tmpDir, 'dist', 'my-agent.wasm');
      ensureIcpManifest(tmpDir, 'my-agent', wasmPath);

      const renamed = path.join(tmpDir, 'dist', 'renamed-agent.wasm');
      const result = ensureIcpManifest(tmpDir, 'renamed-agent', renamed);

      expect(result.action).toBe('updated');
      const content = fs.readFileSync(result.path, 'utf-8');
      expect(content).toContain('name: renamed-agent');
      expect(content).not.toContain('name: my-agent');
    });

    it('should not overwrite a user-managed manifest', () => {
      const manifestPath = icpManifestPath(tmpDir);
      const userContent = 'canisters:\n  - name: custom\n';
      fs.writeFileSync(manifestPath, userContent, 'utf-8');

      const wasmPath = path.join(tmpDir, 'dist', 'my-agent.wasm');
      const result = ensureIcpManifest(tmpDir, 'my-agent', wasmPath);

      expect(result.action).toBe('kept');
      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(userContent);
    });
  });
});
