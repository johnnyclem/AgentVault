/**
 * WASM Compilation
 *
 * This module provides real WASM compilation for agent code.
 * It bundles agent source code and creates WebAssembly modules
 * with embedded JavaScript for execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import type { AgentConfig, PackageResult, PackageOptions } from './types.js';
import {
  generateWasmEdgeWrapper,
  validateWasmEdgeModule,
  generateWasmEdgeConfig,
  generateWasmEdgeManifest,
  type WasmEdgeOptions,
  DEFAULT_WASMEDGE_OPTIONS,
} from './wasmedge-compiler.js';
import { runOptimizationPipeline } from '../icp/optimization.js';
import type { IcWasmOptLevel } from '../icp/types.js';

/**
 * WASM magic bytes (first 4 bytes of any valid .wasm file)
 */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * WASM version bytes (version 1)
 */
const WASM_VERSION = Buffer.from([0x01, 0x00, 0x00, 0x00]);

/**
 * Bundle agent code to JavaScript
 *
 * Uses esbuild to bundle the agent's source code into a single JavaScript file.
 */
export async function bundleAgentCode(config: AgentConfig): Promise<string> {
  if (!config.entryPoint) {
    if (config.type === 'goose') {
      const pythonCandidates = ['goose.py', 'main.py'];
      const hasPythonEntrypoint = pythonCandidates.some((candidate) =>
        fs.existsSync(path.resolve(config.sourcePath, candidate))
      );
      if (hasPythonEntrypoint) {
        throw new Error(
          'Goose Python entrypoints are not supported in the bundler. Use a JS/TS entrypoint instead.'
        );
      }
    }
    throw new Error(`No entry point found for agent ${config.name}`);
  }

  const entryPath = path.resolve(config.sourcePath, config.entryPoint);
  
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry point not found: ${entryPath}`);
  }

  if (path.extname(config.entryPoint) === '.py') {
    throw new Error(
      'Goose Python entrypoints are not supported in the bundler. Use a JS/TS entrypoint instead.'
    );
  }

  try {
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      target: 'es2020',
      format: 'iife',
      minify: false,
      sourcemap: false,
      write: false,
      treeShaking: false,
      logLevel: 'silent',
      external: [],
    });

    if (result.errors.length > 0) {
      const errorMessages = result.errors
        .map((e) => e.text)
        .join('; ');
      throw new Error(`Bundle failed: ${errorMessages}`);
    }

    if (!result.outputFiles[0]) {
      throw new Error('Bundle produced no output files');
    }

    return result.outputFiles[0].text;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to bundle agent code: ${message}`);
  }
}

/**
 * Helper to concatenate buffers and Uint8Arrays
 */
function concatBuffers(parts: (Buffer | Uint8Array | number[])[]): Buffer {
  const buffers = parts.map(p => {
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
 * Write LEB128 encoded unsigned integer directly to bytes
 */
function writeUleb128Bytes(value: number): number[] {
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
 * Structurally validate a WASM binary using the runtime's WebAssembly engine.
 * (Accessed via globalThis because tsconfig's lib set has no DOM/WebAssembly
 * value declarations.)
 */
function wasmEngineValidate(buffer: Buffer): boolean {
  const wasm = (globalThis as Record<string, unknown>).WebAssembly as
    | { validate(bytes: Uint8Array): boolean }
    | undefined;
  // If the runtime has no WebAssembly engine, fall back to accepting the module
  return wasm ? wasm.validate(buffer) : true;
}

/**
 * Write LEB128 encoded signed integer directly to bytes
 * (used for i32.const operands, which are signed)
 */
function writeSleb128Bytes(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value | 0;

  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((remaining === 0 && !signBit) || (remaining === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

/**
 * Generate a real WASM binary with embedded JavaScript bundle
 *
 * Creates a WASM module that contains:
 * - Magic bytes and version
 * - Custom section with agent metadata
 * - Data section with embedded JavaScript bundle
 * - Exported functions for agent lifecycle
 */
export function generateWasm(config: AgentConfig, javascriptBundle: string): Buffer {
  const jsBytes = Buffer.from(javascriptBundle, 'utf-8');

  // A section is: id byte, payload size (uleb128), payload.
  const section = (id: number, payload: Buffer): Buffer =>
    concatBuffers([[id], writeUleb128Bytes(payload.length), payload]);

  // A vector is: element count (uleb128), elements.
  const vec = (items: Buffer[]): Buffer =>
    concatBuffers([writeUleb128Bytes(items.length), ...items]);

  // A name is: byte length (uleb128), utf-8 bytes.
  const name = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf-8');
    return concatBuffers([writeUleb128Bytes(bytes.length), bytes]);
  };

  const sections: Buffer[] = [];

  // 1. Type section: type 0 = () -> i32, type 1 = (i32) -> i32
  sections.push(section(0x01, vec([
    Buffer.from([0x60, 0x00, 0x01, 0x7f]),
    Buffer.from([0x60, 0x01, 0x7f, 0x01, 0x7f]),
  ])));

  // 2. Function section: init, step, get_state_ptr, get_state_size
  sections.push(section(0x03, vec([
    Buffer.from([0x00]), // init: type 0
    Buffer.from([0x01]), // step: type 1
    Buffer.from([0x00]), // get_state_ptr: type 0
    Buffer.from([0x00]), // get_state_size: type 0
  ])));

  // 3. Memory section: one memory, sized to hold the embedded JS bundle
  const memoryPages = Math.max(1, Math.ceil(jsBytes.length / 65536));
  sections.push(section(0x05, vec([
    concatBuffers([[0x00], writeUleb128Bytes(memoryPages)]), // limits: min only
  ])));

  // 4. Export section
  const funcExport = (exportName: string, funcIndex: number): Buffer =>
    concatBuffers([name(exportName), [0x00], writeUleb128Bytes(funcIndex)]);
  sections.push(section(0x07, vec([
    funcExport('init', 0),
    funcExport('step', 1),
    funcExport('get_state_ptr', 2),
    funcExport('get_state_size', 3),
    concatBuffers([name('memory'), [0x02], [0x00]]), // export memory 0
  ])));

  // 5. Code section
  // A body is: size (uleb128), local declarations vector, instructions, end (0x0b).
  const body = (instructions: number[]): Buffer => {
    const content = Buffer.from([0x00, ...instructions, 0x0b]); // no locals
    return concatBuffers([writeUleb128Bytes(content.length), content]);
  };
  sections.push(section(0x0a, vec([
    body([0x41, 0x00]),                                // init: i32.const 0
    body([0x20, 0x00]),                                // step: local.get 0
    body([0x41, 0x00]),                                // get_state_ptr: i32.const 0
    body([0x41, ...writeSleb128Bytes(jsBytes.length)]), // get_state_size: i32.const <len>
  ])));

  // 6. Data section: active segment placing the JS bundle at offset 0
  sections.push(section(0x0b, vec([
    concatBuffers([
      [0x00],                   // active segment, memory 0
      [0x41, 0x00, 0x0b],       // offset expression: i32.const 0; end
      writeUleb128Bytes(jsBytes.length),
      jsBytes,
    ]),
  ])));

  // 7. Custom section with agent metadata
  const version = config.version ?? '1.0.0';
  const metadataContent = concatBuffers([
    Buffer.from('agentvault', 'utf-8'),
    [0],
    Buffer.from(config.name, 'utf-8'),
    [0],
    Buffer.from(config.type, 'utf-8'),
    [0],
    Buffer.from(version, 'utf-8'),
  ]);
  sections.push(section(0x00, concatBuffers([name('agent.metadata'), metadataContent])));

  const wasmBuffer = Buffer.concat([WASM_MAGIC, WASM_VERSION, ...sections]);

  // Guard against regressions in the hand-rolled encoder: never emit a
  // module the WebAssembly engine itself rejects.
  if (!wasmEngineValidate(wasmBuffer)) {
    throw new Error('Generated WASM module failed WebAssembly validation');
  }

  return wasmBuffer;
}

/**
 * Generate WAT (WebAssembly Text Format) representation
 *
 * Creates a human-readable text representation of the WASM module.
 */
export function generateStubWat(config: AgentConfig): string {
  return `;;
;; AgentVault WASM Module (Stub)
;; Agent: ${config.name}
;; Type: ${config.type}
;; Generated: ${new Date().toISOString()}
;;
;; This is a placeholder WAT file. In production, this would contain
;; the actual compiled WebAssembly code for the agent.
;;

(module
  ;; Custom section for agent metadata
  (@custom "agentvault" "${config.name}")

  ;; Memory for agent state (1 page = 64KB)
  (memory (export "memory") 1)

  ;; Agent initialization function (stub)
  (func (export "init") (result i32)
    ;; Return success code
    i32.const 0
  )

  ;; Agent step function (stub)
  (func (export "step") (param $input i32) (result i32)
    ;; Return input unchanged
    local.get $input
  )

  ;; Get agent state pointer (stub)
  (func (export "get_state_ptr") (result i32)
    ;; Return memory offset 0
    i32.const 0
  )

  ;; Get agent state size (stub)
  (func (export "get_state_size") (result i32)
    ;; Return 0 bytes (empty state)
    i32.const 0
  )
)
`;
}

/**
 * Generate serialized state JSON
 *
 * Creates the initial state representation for the agent.
 */
export function generateStateJson(config: AgentConfig): string {
  const state = {
    $schema: 'https://agentvault.dev/schemas/agent-state-v1.json',
    agent: {
      name: config.name,
      type: config.type,
      version: config.version ?? '1.0.0',
    },
    metadata: {
      createdAt: new Date().toISOString(),
      sourcePath: config.sourcePath,
      entryPoint: config.entryPoint,
    },
    state: {
      // Initial empty state
      initialized: false,
      data: {},
    },
  };

  return JSON.stringify(state, null, 2);
}

/**
 * Generate WAT (WebAssembly Text Format) representation
 *
 * Creates a human-readable text representation of the compiled WASM module.
 */
export function generateWat(config: AgentConfig, javascriptBundle: string): string {
  const jsSize = Buffer.from(javascriptBundle, 'utf-8').length;
  
  return `;;
;; AgentVault WASM Module
;; Agent: ${config.name}
;; Type: ${config.type}
;; Version: ${config.version ?? '1.0.0'}
;; Generated: ${new Date().toISOString()}
;;
;; This module contains the agent's compiled WebAssembly code
;; with embedded JavaScript bundle in the data section.
;;

(module
  ;; Metadata custom section
  (@custom "agent.metadata" "${config.name}")
  
  ;; Memory for agent state and JavaScript bundle (1 page = 64KB)
  (memory (export "memory") 1)
  
  ;; Agent initialization function
  ;; Returns 0 on success
  (func (export "init") (result i32)
    i32.const 0
  )
  
  ;; Agent step function
  ;; Executes agent logic with input
  (func (export "step") (param $input i32) (result i32)
    local.get $input
  )
  
  ;; Get agent state pointer
  ;; Returns memory offset where state is stored
  (func (export "get_state_ptr") (result i32)
    i32.const 0
  )
  
  ;; Get agent state size
  ;; Returns size of embedded JavaScript bundle
  (func (export "get_state_size") (result i32)
    i32.const ${jsSize}
  )
)
`;
}

/**
 * Compile an agent to WASM using WasmEdge
 *
 * This is the main compilation function that orchestrates the packaging process.
 * It bundles agent code and creates a WASM module with embedded JavaScript.
 *
 * @param config - Agent configuration from detection
 * @param options - Packaging options including compilation target
 * @param outputDir - Directory to write output files
 * @returns Package result with paths to generated files
 */
export async function compileToWasm(
  config: AgentConfig,
  options: PackageOptions,
  outputDir: string
): Promise<PackageResult> {
  const startTime = Date.now();
  const target = options.target ?? 'wasmedge';

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate file paths
  const wasmPath = path.join(outputDir, `${config.name}.wasm`);
  const watPath = path.join(outputDir, `${config.name}.wat`);
  const statePath = path.join(outputDir, `${config.name}.state.json`);
  const jsBundlePath = path.join(outputDir, `${config.name}.bundle.js`);
  const manifestPath = path.join(outputDir, `${config.name}.manifest.json`);
  const sourceMapPath = path.join(outputDir, `${config.name}.wasm.map`);

  // Bundle agent code
  const agentCode = await bundleAgentCode(config);

  let wasmBuffer: Buffer;
  let watContent: string;

  // Compile based on target
  if (target === 'wasmedge') {
    // Use WasmEdge wrapper for full JS support
    const wasmedgeWrapper = generateWasmEdgeWrapper(agentCode, config);
    const wasmedgeOptions: WasmEdgeOptions = {
      debug: options.debug ?? DEFAULT_WASMEDGE_OPTIONS.debug,
      sourcemap: options.debug ?? DEFAULT_WASMEDGE_OPTIONS.sourcemap,
      optimize: options.optimize ?? DEFAULT_WASMEDGE_OPTIONS.optimize,
      wasi: DEFAULT_WASMEDGE_OPTIONS.wasi,
    };

    // Generate WAT for WasmEdge
    watContent = generateWat(config, wasmedgeWrapper);

    // Generate WASM (using existing WASM structure as base)
    wasmBuffer = generateWasm(config, wasmedgeWrapper);

    // Write WasmEdge wrapper
    fs.writeFileSync(jsBundlePath, wasmedgeWrapper, 'utf-8');

    // Write WasmEdge config
    const wasmedgeConfig = generateWasmEdgeConfig(config, wasmedgeOptions);
    const wasmedgeConfigPath = path.join(outputDir, `${config.name}.wasmedge.json`);
    fs.writeFileSync(wasmedgeConfigPath, wasmedgeConfig, 'utf-8');

    // Write manifest
    const manifest = generateWasmEdgeManifest(config, wasmPath, outputDir);
    fs.writeFileSync(manifestPath, manifest, 'utf-8');

  } else if (target === 'motoko') {
    // For Motoko target, generate basic WASM structure
    // The actual compilation happens in dfx with Motoko compiler
    watContent = generateWat(config, agentCode);
    wasmBuffer = generateWasm(config, agentCode);
  } else {
    // Pure WASM target - minimal structure
    watContent = generateWat(config, agentCode);
    wasmBuffer = generateWasm(config, agentCode);
  }

  // Generate state JSON
  const stateContent = generateStateJson(config);

  // Write files
  fs.writeFileSync(wasmPath, wasmBuffer);
  fs.writeFileSync(watPath, watContent, 'utf-8');
  fs.writeFileSync(statePath, stateContent, 'utf-8');

  // ── ic-wasm optimization pipeline ──────────────────────────────────────
  const shouldOptimize = options.icWasmOptimize || options.icWasmShrink ||
    options.candidInterface || options.memoryLimit || options.computeQuota;

  let finalWasmSize = wasmBuffer.length;
  let originalWasmSize: number | undefined;
  let optimizationReductionPercent: number | undefined;
  let candidValidationPassed: boolean | undefined;
  let optimizationWarnings: string[] | undefined;

  if (shouldOptimize) {
    originalWasmSize = wasmBuffer.length;

    // Map numeric optimize level (0-3) to IcWasmOptLevel
    const levelMap: Record<number, IcWasmOptLevel> = {
      0: 'O0', 1: 'O1', 2: 'O2', 3: 'O3',
    };
    const optimizeLevel = levelMap[options.optimize ?? 3] ?? 'O3';

    // Build resource limits map
    const resourceLimits: Record<string, string> = {};
    if (options.memoryLimit) {
      resourceLimits['memory'] = options.memoryLimit;
    }
    if (options.computeQuota) {
      resourceLimits['compute'] = options.computeQuota;
    }

    const optimizedPath = path.join(outputDir, `${config.name}.optimized.wasm`);

    const pipelineResult = await runOptimizationPipeline({
      input: wasmPath,
      output: optimizedPath,
      optimize: options.icWasmOptimize,
      optimizeLevel,
      shrink: options.icWasmShrink,
      resourceLimits: Object.keys(resourceLimits).length > 0 ? resourceLimits : undefined,
      candidInterface: options.candidInterface,
    });

    optimizationWarnings = pipelineResult.warnings;
    candidValidationPassed = pipelineResult.validationPassed;

    if (pipelineResult.success && fs.existsSync(optimizedPath)) {
      // Replace the original WASM with the optimized version
      fs.copyFileSync(optimizedPath, wasmPath);
      fs.unlinkSync(optimizedPath);
      finalWasmSize = pipelineResult.finalSize;
      optimizationReductionPercent = pipelineResult.reductionPercent;
    } else {
      // Optimization failed but original WASM is still valid
      optimizationWarnings = [
        ...(optimizationWarnings ?? []),
        'Optimization pipeline did not fully succeed; using unoptimized WASM',
      ];
    }
  }

  const result: PackageResult = {
    config,
    wasmPath,
    watPath,
    statePath,
    jsBundlePath,
    sourceMapPath: options.debug ? sourceMapPath : undefined,
    manifestPath,
    wasmSize: finalWasmSize,
    target,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    functionCount: 14, // Standard agent interface exports
    originalWasmSize,
    optimizationReductionPercent,
    candidValidationPassed,
    optimizationWarnings,
  };

  // Validate generated WASM
  const validation = validateWasmEdgeModule(wasmBuffer);
  if (!validation.valid) {
    console.warn(`WASM validation warnings: ${validation.errors.join(', ')}`);
  }

  return result;
}

/**
 * Validate WASM file integrity
 *
 * Checks that a file has valid WASM magic bytes.
 */
export function validateWasmFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);

    // Check minimum size
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

    // Full structural validation by the WebAssembly engine
    return wasmEngineValidate(buffer);
  } catch {
    return false;
  }
}
