/**
 * WASM Compiler Abstraction
 *
 * This module provides a clean abstraction for WASM compilation with stub implementations
 * for different compilation targets. It serves as the foundation for future real compilation
 * support (Motoko, Rust, AssemblyScript, etc.).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import type { AgentConfig, PackageResult } from './types.js';

/**
 * Supported compilation targets
 */
export type CompilationTarget = 'javascript' | 'motoko' | 'rust' | 'assemblyscript';

/**
 * WASM compilation options
 */
export interface WasmCompilationOptions {
  /** Compilation target language */
  target: CompilationTarget;
  /** Enable optimization passes */
  optimize?: boolean;
  /** Optimization level (0-3) */
  optimizationLevel?: 0 | 1 | 2 | 3;
  /** Enable debug information */
  debug?: boolean;
  /** Memory configuration */
  memory?: WasmMemoryConfig;
  /** Custom compilation flags */
  flags?: string[];
}

/**
 * WASM memory configuration
 */
export interface WasmMemoryConfig {
  /** Initial memory pages (64KB each) */
  initial: number;
  /** Maximum memory pages (optional) */
  maximum?: number;
  /** Memory is shared across threads */
  shared?: boolean;
}

/**
 * WASM compilation result
 */
export interface WasmCompilationResult {
  /** Compiled WASM binary */
  wasmBinary: Buffer;
  /** WAT text representation */
  watText: string;
  /** Embedded source bundle (if applicable) */
  sourceBundle?: string;
  /** Compilation metadata */
  metadata: WasmCompilationMetadata;
}

/**
 * Compilation metadata
 */
export interface WasmCompilationMetadata {
  /** Compilation target used */
  target: CompilationTarget;
  /** WASM binary size in bytes */
  binarySize: number;
  /** Source bundle size in bytes (if applicable) */
  sourceBundleSize?: number;
  /** Exported functions */
  exports: string[];
  /** Memory configuration used */
  memory: WasmMemoryConfig;
  /** Compilation timestamp */
  timestamp: Date;
  /** Whether this is a stub implementation */
  isStub: boolean;
}

/**
 * WASM magic bytes (first 4 bytes of any valid .wasm file)
 */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * WASM version bytes (version 1)
 */
const WASM_VERSION = Buffer.from([0x01, 0x00, 0x00, 0x00]);

/**
 * Default memory configuration
 */
const DEFAULT_MEMORY_CONFIG: WasmMemoryConfig = {
  initial: 1, // 64KB
  maximum: 16, // 1MB max
  shared: false,
};

/**
 * Default compilation options
 */
const DEFAULT_COMPILATION_OPTIONS: WasmCompilationOptions = {
  target: 'javascript',
  optimize: false,
  optimizationLevel: 0,
  debug: false,
  memory: DEFAULT_MEMORY_CONFIG,
  flags: [],
};

/**
 * Write LEB128 encoded unsigned integer to bytes
 */
function writeUleb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;

  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);

  return bytes;
}

/**
 * Concatenate multiple buffers/arrays into a single Buffer
 */
function concatBuffers(parts: (Buffer | Uint8Array | number[])[]): Buffer {
  const buffers = parts.map((p) => {
    if (Array.isArray(p)) {
      return Buffer.from(p);
    }
    if (p instanceof Uint8Array) {
      return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    }
    return p;
  });
  return Buffer.concat(buffers);
}

/**
 * WASM Compiler class
 *
 * Provides compilation methods for different targets. Currently implements:
 * - JavaScript bundling (real implementation using esbuild)
 * - Motoko compilation (stub)
 * - Rust compilation (stub)
 * - AssemblyScript compilation (stub)
 */
export class WasmCompiler {
  private options: WasmCompilationOptions;

  constructor(options: Partial<WasmCompilationOptions> = {}) {
    this.options = { ...DEFAULT_COMPILATION_OPTIONS, ...options };
  }

  /**
   * Compile agent to WASM
   *
   * Routes to the appropriate compilation method based on target.
   */
  async compile(config: AgentConfig): Promise<WasmCompilationResult> {
    switch (this.options.target) {
      case 'javascript':
        return this.compileJavaScript(config);
      case 'motoko':
        return this.compileMotokoStub(config);
      case 'rust':
        return this.compileRustStub(config);
      case 'assemblyscript':
        return this.compileAssemblyScriptStub(config);
      default:
        throw new Error(`Unsupported compilation target: ${this.options.target}`);
    }
  }

  /**
   * Compile JavaScript/TypeScript to WASM
   *
   * Uses esbuild to bundle the agent code and embeds it in a WASM module.
   * This is the primary compilation path for most agents.
   */
  private async compileJavaScript(config: AgentConfig): Promise<WasmCompilationResult> {
    // Bundle agent code
    const sourceBundle = await this.bundleSource(config);

    // Generate WASM binary with embedded JavaScript
    const wasmBinary = this.generateWasmBinary(config, sourceBundle);

    // Generate WAT text representation
    const watText = this.generateWatText(config, sourceBundle.length);

    return {
      wasmBinary,
      watText,
      sourceBundle,
      metadata: {
        target: 'javascript',
        binarySize: wasmBinary.length,
        sourceBundleSize: Buffer.from(sourceBundle, 'utf-8').length,
        exports: ['init', 'step', 'get_state_ptr', 'get_state_size', 'memory'],
        memory: this.options.memory ?? DEFAULT_MEMORY_CONFIG,
        timestamp: new Date(),
        isStub: false,
      },
    };
  }

  /**
   * Stub: Compile Motoko to WASM
   *
   * This is a placeholder for future Motoko compilation support.
   * Motoko is the native language for Internet Computer canisters.
   */
  private async compileMotokoStub(config: AgentConfig): Promise<WasmCompilationResult> {
    const wasmBinary = this.generateStubWasmBinary(config);
    const watText = this.generateStubWatText(config, 'motoko');

    return {
      wasmBinary,
      watText,
      metadata: {
        target: 'motoko',
        binarySize: wasmBinary.length,
        exports: ['init', 'step', 'get_state_ptr', 'get_state_size', 'memory'],
        memory: this.options.memory ?? DEFAULT_MEMORY_CONFIG,
        timestamp: new Date(),
        isStub: true,
      },
    };
  }

  /**
   * Stub: Compile Rust to WASM
   *
   * This is a placeholder for future Rust compilation support.
   * Would use wasm-pack or cargo-wasm for actual compilation.
   */
  private async compileRustStub(config: AgentConfig): Promise<WasmCompilationResult> {
    const wasmBinary = this.generateStubWasmBinary(config);
    const watText = this.generateStubWatText(config, 'rust');

    return {
      wasmBinary,
      watText,
      metadata: {
        target: 'rust',
        binarySize: wasmBinary.length,
        exports: ['init', 'step', 'get_state_ptr', 'get_state_size', 'memory'],
        memory: this.options.memory ?? DEFAULT_MEMORY_CONFIG,
        timestamp: new Date(),
        isStub: true,
      },
    };
  }

  /**
   * Stub: Compile AssemblyScript to WASM
   *
   * This is a placeholder for future AssemblyScript compilation support.
   * AssemblyScript compiles TypeScript-like syntax directly to WASM.
   */
  private async compileAssemblyScriptStub(config: AgentConfig): Promise<WasmCompilationResult> {
    const wasmBinary = this.generateStubWasmBinary(config);
    const watText = this.generateStubWatText(config, 'assemblyscript');

    return {
      wasmBinary,
      watText,
      metadata: {
        target: 'assemblyscript',
        binarySize: wasmBinary.length,
        exports: ['init', 'step', 'get_state_ptr', 'get_state_size', 'memory'],
        memory: this.options.memory ?? DEFAULT_MEMORY_CONFIG,
        timestamp: new Date(),
        isStub: true,
      },
    };
  }

  /**
   * Bundle source code using esbuild
   */
  private async bundleSource(config: AgentConfig): Promise<string> {
    if (!config.entryPoint) {
      throw new Error(`No entry point found for agent ${config.name}`);
    }

    const entryPath = path.resolve(config.sourcePath, config.entryPoint);

    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry point not found: ${entryPath}`);
    }

    try {
      const result = await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'browser',
        target: 'es2020',
        format: 'iife',
        minify: this.options.optimize ?? false,
        sourcemap: this.options.debug ?? false,
        write: false,
        treeShaking: this.options.optimize ?? false,
        logLevel: 'silent',
        external: [],
      });

      if (result.errors.length > 0) {
        const errorMessages = result.errors.map((e) => e.text).join('; ');
        throw new Error(`Bundle failed: ${errorMessages}`);
      }

      if (!result.outputFiles?.[0]) {
        throw new Error('Bundle produced no output files');
      }

      return result.outputFiles[0].text;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to bundle agent code: ${message}`);
    }
  }

  /**
   * Generate WASM binary with embedded source bundle
   */
  private generateWasmBinary(config: AgentConfig, sourceBundle: string): Buffer {
    const agentNameBytes = Buffer.from(config.name, 'utf-8');
    const jsBytes = Buffer.from(sourceBundle, 'utf-8');
    const memoryConfig = this.options.memory ?? DEFAULT_MEMORY_CONFIG;

    const sections: Buffer[] = [];

    // 1. Custom section with metadata
    const metadataContent = Buffer.concat([
      Buffer.from('agentvault', 'utf-8'),
      Buffer.from([0]),
      agentNameBytes,
      Buffer.from([0]),
      Buffer.from(config.type, 'utf-8'),
      Buffer.from([0]),
      Buffer.from(config.version ?? '1.0.0', 'utf-8'),
    ]);

    const customSectionName = Buffer.from('agent.metadata', 'utf-8');
    const customSection = concatBuffers([
      Buffer.from([0x00]), // section id: custom
      concatBuffers([writeUleb128(customSectionName.length + 1 + metadataContent.length)]),
      customSectionName,
      Buffer.from([0]),
      metadataContent,
    ]);
    sections.push(customSection);

    // 2. Type section
    const typeSectionContent = Buffer.concat([
      Buffer.from([0x60, 0x00, 0x01, 0x7f]), // () -> i32
      Buffer.from([0x60, 0x01, 0x7f, 0x01, 0x7f]), // (i32) -> i32
    ]);

    const typeSection = concatBuffers([
      Buffer.from([0x01]), // section id: type
      concatBuffers([writeUleb128(typeSectionContent.length + 1)]),
      Buffer.from([0x02]), // 2 types
      typeSectionContent,
    ]);
    sections.push(typeSection);

    // 3. Function section
    const funcSection = concatBuffers([
      Buffer.from([0x03]), // section id: function
      Buffer.from([0x05]), // section size
      Buffer.from([0x04]), // 4 functions
      Buffer.from([0x00, 0x01, 0x00, 0x00]), // type indices
    ]);
    sections.push(funcSection);

    // 4. Memory section
    const memorySection = concatBuffers([
      Buffer.from([0x05]), // section id: memory
      Buffer.from([0x03]), // section size
      Buffer.from([0x01]), // 1 memory
      Buffer.from([0x01]), // flags: has max
      concatBuffers([writeUleb128(memoryConfig.initial)]),
    ]);
    sections.push(memorySection);

    // 5. Export section
    const exports = [
      { name: 'init', kind: 0x00, index: 0 },
      { name: 'step', kind: 0x00, index: 1 },
      { name: 'get_state_ptr', kind: 0x00, index: 2 },
      { name: 'get_state_size', kind: 0x00, index: 3 },
      { name: 'memory', kind: 0x02, index: 0 },
    ];

    const exportEntries = exports.map((exp) =>
      concatBuffers([
        writeUleb128(exp.name.length),
        Buffer.from(exp.name, 'utf-8'),
        Buffer.from([exp.kind]),
        writeUleb128(exp.index),
      ])
    );

    const exportContent = concatBuffers([writeUleb128(exports.length), ...exportEntries]);

    const exportSection = concatBuffers([
      Buffer.from([0x07]), // section id: export
      concatBuffers([writeUleb128(exportContent.length)]),
      exportContent,
    ]);
    sections.push(exportSection);

    // 6. Code section
    const funcBodies = [
      // init: return 0
      Buffer.from([0x04, 0x00, 0x41, 0x00, 0x0b]),
      // step: return input
      Buffer.from([0x04, 0x00, 0x20, 0x00, 0x0b]),
      // get_state_ptr: return 0
      Buffer.from([0x04, 0x00, 0x41, 0x00, 0x0b]),
      // get_state_size: return bundle size
      concatBuffers([
        writeUleb128(3 + writeUleb128(jsBytes.length).length),
        Buffer.from([0x00]), // no locals
        Buffer.from([0x41]), // i32.const
        writeUleb128(jsBytes.length),
        Buffer.from([0x0b]), // end
      ]),
    ];

    const codeContent = concatBuffers([writeUleb128(funcBodies.length), ...funcBodies]);

    const codeSection = concatBuffers([
      Buffer.from([0x0a]), // section id: code
      concatBuffers([writeUleb128(codeContent.length)]),
      codeContent,
    ]);
    sections.push(codeSection);

    // 7. Data section with embedded JavaScript
    const dataContent = concatBuffers([
      Buffer.from([0x01]), // 1 data segment
      Buffer.from([0x00]), // memory index 0
      Buffer.from([0x41, 0x00, 0x0b]), // i32.const 0, end
      writeUleb128(jsBytes.length),
      jsBytes,
    ]);

    const dataSection = concatBuffers([
      Buffer.from([0x0b]), // section id: data
      concatBuffers([writeUleb128(dataContent.length)]),
      dataContent,
    ]);
    sections.push(dataSection);

    return Buffer.concat([WASM_MAGIC, WASM_VERSION, ...sections]);
  }

  /**
   * Generate stub WASM binary (minimal valid WASM without embedded code)
   */
  private generateStubWasmBinary(config: AgentConfig): Buffer {
    const agentNameBytes = Buffer.from(config.name, 'utf-8');
    const memoryConfig = this.options.memory ?? DEFAULT_MEMORY_CONFIG;

    const sections: Buffer[] = [];

    // 1. Custom section with metadata
    const metadataContent = Buffer.concat([
      Buffer.from('agentvault-stub', 'utf-8'),
      Buffer.from([0]),
      agentNameBytes,
      Buffer.from([0]),
      Buffer.from(config.type, 'utf-8'),
      Buffer.from([0]),
      Buffer.from(config.version ?? '1.0.0', 'utf-8'),
      Buffer.from([0]),
      Buffer.from(this.options.target, 'utf-8'),
    ]);

    const customSectionName = Buffer.from('agent.stub', 'utf-8');
    const customSection = concatBuffers([
      Buffer.from([0x00]),
      concatBuffers([writeUleb128(customSectionName.length + 1 + metadataContent.length)]),
      customSectionName,
      Buffer.from([0]),
      metadataContent,
    ]);
    sections.push(customSection);

    // 2. Type section
    const typeSection = concatBuffers([
      Buffer.from([0x01]), // section id: type
      Buffer.from([0x09]), // section size
      Buffer.from([0x02]), // 2 types
      Buffer.from([0x60, 0x00, 0x01, 0x7f]), // () -> i32
      Buffer.from([0x60, 0x01, 0x7f, 0x01, 0x7f]), // (i32) -> i32
    ]);
    sections.push(typeSection);

    // 3. Function section
    const funcSection = concatBuffers([
      Buffer.from([0x03]),
      Buffer.from([0x05]),
      Buffer.from([0x04]),
      Buffer.from([0x00, 0x01, 0x00, 0x00]),
    ]);
    sections.push(funcSection);

    // 4. Memory section
    const memorySection = concatBuffers([
      Buffer.from([0x05]),
      Buffer.from([0x03]),
      Buffer.from([0x01]),
      Buffer.from([0x01]),
      concatBuffers([writeUleb128(memoryConfig.initial)]),
    ]);
    sections.push(memorySection);

    // 5. Export section
    const exports = [
      { name: 'init', kind: 0x00, index: 0 },
      { name: 'step', kind: 0x00, index: 1 },
      { name: 'get_state_ptr', kind: 0x00, index: 2 },
      { name: 'get_state_size', kind: 0x00, index: 3 },
      { name: 'memory', kind: 0x02, index: 0 },
    ];

    const exportEntries = exports.map((exp) =>
      concatBuffers([
        writeUleb128(exp.name.length),
        Buffer.from(exp.name, 'utf-8'),
        Buffer.from([exp.kind]),
        writeUleb128(exp.index),
      ])
    );

    const exportContent = concatBuffers([writeUleb128(exports.length), ...exportEntries]);

    const exportSection = concatBuffers([
      Buffer.from([0x07]),
      concatBuffers([writeUleb128(exportContent.length)]),
      exportContent,
    ]);
    sections.push(exportSection);

    // 6. Code section with stub implementations
    const funcBodies = [
      Buffer.from([0x04, 0x00, 0x41, 0x00, 0x0b]), // init: return 0
      Buffer.from([0x04, 0x00, 0x20, 0x00, 0x0b]), // step: return input
      Buffer.from([0x04, 0x00, 0x41, 0x00, 0x0b]), // get_state_ptr: return 0
      Buffer.from([0x04, 0x00, 0x41, 0x00, 0x0b]), // get_state_size: return 0
    ];

    const codeContent = concatBuffers([writeUleb128(funcBodies.length), ...funcBodies]);

    const codeSection = concatBuffers([
      Buffer.from([0x0a]),
      concatBuffers([writeUleb128(codeContent.length)]),
      codeContent,
    ]);
    sections.push(codeSection);

    return Buffer.concat([WASM_MAGIC, WASM_VERSION, ...sections]);
  }

  /**
   * Generate WAT text representation
   */
  private generateWatText(config: AgentConfig, bundleSize: number): string {
    const memoryConfig = this.options.memory ?? DEFAULT_MEMORY_CONFIG;

    return `;;
;; AgentVault WASM Module
;; Agent: ${config.name}
;; Type: ${config.type}
;; Version: ${config.version ?? '1.0.0'}
;; Target: javascript
;; Generated: ${new Date().toISOString()}
;;
;; This module contains the agent's compiled WebAssembly code
;; with embedded JavaScript bundle in the data section.
;;

(module
  ;; Metadata custom section
  (@custom "agent.metadata" "${config.name}")

  ;; Memory for agent state and JavaScript bundle
  (memory (export "memory") ${memoryConfig.initial}${memoryConfig.maximum ? ` ${memoryConfig.maximum}` : ''})

  ;; Type definitions
  (type $t0 (func (result i32)))
  (type $t1 (func (param i32) (result i32)))

  ;; Agent initialization function
  ;; Returns 0 on success
  (func (export "init") (type $t0) (result i32)
    i32.const 0
  )

  ;; Agent step function
  ;; Executes agent logic with input
  (func (export "step") (type $t1) (param $input i32) (result i32)
    local.get $input
  )

  ;; Get agent state pointer
  ;; Returns memory offset where state is stored
  (func (export "get_state_ptr") (type $t0) (result i32)
    i32.const 0
  )

  ;; Get agent state size
  ;; Returns size of embedded JavaScript bundle
  (func (export "get_state_size") (type $t0) (result i32)
    i32.const ${bundleSize}
  )

  ;; Data section with embedded JavaScript bundle
  (data (i32.const 0) "...")
)
`;
  }

  /**
   * Generate stub WAT text representation
   */
  private generateStubWatText(config: AgentConfig, target: CompilationTarget): string {
    const memoryConfig = this.options.memory ?? DEFAULT_MEMORY_CONFIG;

    return `;;
;; AgentVault WASM Module (Stub)
;; Agent: ${config.name}
;; Type: ${config.type}
;; Version: ${config.version ?? '1.0.0'}
;; Target: ${target}
;; Generated: ${new Date().toISOString()}
;;
;; This is a stub implementation. In production, this would be
;; compiled from ${target} source code using the appropriate toolchain.
;;

(module
  ;; Metadata custom section
  (@custom "agent.stub" "${config.name}")

  ;; Memory for agent state
  (memory (export "memory") ${memoryConfig.initial}${memoryConfig.maximum ? ` ${memoryConfig.maximum}` : ''})

  ;; Type definitions
  (type $t0 (func (result i32)))
  (type $t1 (func (param i32) (result i32)))

  ;; Agent initialization function (stub)
  ;; Returns 0 to indicate success
  (func (export "init") (type $t0) (result i32)
    ;; TODO: Implement ${target} initialization
    i32.const 0
  )

  ;; Agent step function (stub)
  ;; Returns input unchanged
  (func (export "step") (type $t1) (param $input i32) (result i32)
    ;; TODO: Implement ${target} step logic
    local.get $input
  )

  ;; Get agent state pointer (stub)
  ;; Returns memory offset 0
  (func (export "get_state_ptr") (type $t0) (result i32)
    ;; TODO: Return actual state pointer
    i32.const 0
  )

  ;; Get agent state size (stub)
  ;; Returns 0 (no state)
  (func (export "get_state_size") (type $t0) (result i32)
    ;; TODO: Return actual state size
    i32.const 0
  )
)
`;
  }
}

/**
 * Compile agent to WASM and write output files
 *
 * High-level function that handles the full compilation pipeline.
 */
export async function compileAgentToWasm(
  config: AgentConfig,
  outputDir: string,
  options: Partial<WasmCompilationOptions> = {}
): Promise<PackageResult> {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create compiler with options
  const compiler = new WasmCompiler(options);

  // Compile agent
  const result = await compiler.compile(config);

  // Generate file paths
  const wasmPath = path.join(outputDir, `${config.name}.wasm`);
  const watPath = path.join(outputDir, `${config.name}.wat`);
  const statePath = path.join(outputDir, `${config.name}.state.json`);

  // Write WASM binary
  fs.writeFileSync(wasmPath, result.wasmBinary);

  // Write WAT text
  fs.writeFileSync(watPath, result.watText, 'utf-8');

  // Generate and write state JSON
  const stateJson = generateAgentStateJson(config, result.metadata);
  fs.writeFileSync(statePath, stateJson, 'utf-8');

  // Write source bundle if available
  if (result.sourceBundle) {
    const bundlePath = path.join(outputDir, `${config.name}.bundle.js`);
    fs.writeFileSync(bundlePath, result.sourceBundle, 'utf-8');
  }

  return {
    config,
    wasmPath,
    watPath,
    statePath,
    wasmSize: result.wasmBinary.length,
    timestamp: result.metadata.timestamp,
  };
}

/**
 * Generate agent state JSON
 */
function generateAgentStateJson(
  config: AgentConfig,
  metadata: WasmCompilationMetadata
): string {
  const state = {
    $schema: 'https://agentvault.dev/schemas/agent-state-v1.json',
    agent: {
      name: config.name,
      type: config.type,
      version: config.version ?? '1.0.0',
    },
    compilation: {
      target: metadata.target,
      isStub: metadata.isStub,
      exports: metadata.exports,
      memory: metadata.memory,
    },
    metadata: {
      createdAt: metadata.timestamp.toISOString(),
      sourcePath: config.sourcePath,
      entryPoint: config.entryPoint,
      binarySize: metadata.binarySize,
      sourceBundleSize: metadata.sourceBundleSize,
    },
    state: {
      initialized: false,
      data: {},
    },
  };

  return JSON.stringify(state, null, 2);
}

/**
 * Validate WASM binary
 *
 * Checks that a buffer has valid WASM magic bytes and version.
 */
export function validateWasmBinary(buffer: Buffer): boolean {
  if (buffer.length < 8) {
    return false;
  }

  // Check magic bytes
  if (!buffer.subarray(0, 4).equals(WASM_MAGIC)) {
    return false;
  }

  // Check version
  if (!buffer.subarray(4, 8).equals(WASM_VERSION)) {
    return false;
  }

  return true;
}

/**
 * Get supported compilation targets
 */
export function getSupportedTargets(): CompilationTarget[] {
  return ['javascript', 'motoko', 'rust', 'assemblyscript'];
}

/**
 * Check if a compilation target is supported (non-stub)
 */
export function isTargetFullySupported(target: CompilationTarget): boolean {
  // Currently only JavaScript has full support
  return target === 'javascript';
}
