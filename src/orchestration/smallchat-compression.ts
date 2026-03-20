/**
 * SmallChat Intent Compression — "Compression of Future Intent"
 *
 * Reduces the on-chain and in-memory footprint of agent tool call sequences.
 * Three compression strategies:
 *
 *   1. Selector interning — verbose names → compact numeric IDs
 *   2. Sequence compression — repeated multi-step patterns → single composite selector
 *   3. Binary encoding — 38-byte fixed-width records vs ~500+ byte JSON
 *
 * Designed for ICP canister constraints (64 MB heap limit, cycle-metered compute).
 */

import * as crypto from 'node:crypto';
import type { CompressedToolCall } from './smallchat-bridge.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Compact binary representation of a tool call for on-chain storage. */
export interface BinaryToolCallRecord {
  /** Raw bytes: [2-byte selectorId][32-byte paramHash][4-byte timestampDelta] */
  bytes: Uint8Array;
  /** Human-readable summary for debugging */
  summary: string;
}

/** A detected multi-step pattern in agent tool call history. */
export interface IntentPattern {
  /** Pattern identifier */
  id: string;
  /** Ordered selector sequence that defines this pattern */
  selectors: string[];
  /** How many times this pattern has been observed */
  occurrences: number;
  /** Composite selector name for the compressed version */
  compositeSelector: string;
  /** First observed timestamp */
  firstSeen: number;
  /** Last observed timestamp */
  lastSeen: number;
}

export interface CompressionStats {
  totalCalls: number;
  uniqueSelectors: number;
  bytesOriginal: number;
  bytesCompressed: number;
  compressionRatio: number;
  patternsDetected: number;
  patternHits: number;
}

export interface IntentCompressorConfig {
  /** Minimum pattern occurrences before creating a composite selector (default: 3) */
  patternThreshold?: number;
  /** Maximum pattern length to detect (default: 5) */
  maxPatternLength?: number;
  /** History window size for pattern detection (default: 100) */
  historyWindow?: number;
}

// ---------------------------------------------------------------------------
// Binary encoding constants
// ---------------------------------------------------------------------------

/** Fixed-width record: 2 (selectorId) + 32 (paramHash) + 4 (timestampDelta) = 38 bytes */
const RECORD_SIZE = 38;
const SELECTOR_ID_OFFSET = 0;
const PARAM_HASH_OFFSET = 2;
const TIMESTAMP_OFFSET = 34;

// ---------------------------------------------------------------------------
// Intent Compressor
// ---------------------------------------------------------------------------

export class IntentCompressor {
  private history: CompressedToolCall[] = [];
  private patterns = new Map<string, IntentPattern>();
  private baseTimestamp: number;
  private config: Required<IntentCompressorConfig>;

  private stats = {
    totalCalls: 0,
    bytesOriginal: 0,
    bytesCompressed: 0,
    patternHits: 0,
  };

  constructor(config: IntentCompressorConfig = {}) {
    this.config = {
      patternThreshold: config.patternThreshold ?? 3,
      maxPatternLength: config.maxPatternLength ?? 5,
      historyWindow: config.historyWindow ?? 100,
    };
    this.baseTimestamp = Date.now();
  }

  /**
   * Record a tool call and return its compact binary representation.
   */
  encode(toolCall: CompressedToolCall): BinaryToolCallRecord {
    this.stats.totalCalls++;

    // Track original size (estimated JSON encoding)
    const originalJson = JSON.stringify({
      selector: toolCall.selector,
      parameters: toolCall.parameters,
      resolvedMethod: toolCall.resolvedMethod,
      timestamp: toolCall.resolvedAt,
    });
    this.stats.bytesOriginal += originalJson.length;

    // Add to history for pattern detection
    this.history.push(toolCall);
    if (this.history.length > this.config.historyWindow) {
      this.history.shift();
    }

    // Encode to fixed-width binary
    const bytes = new Uint8Array(RECORD_SIZE);
    const view = new DataView(bytes.buffer);

    // 2-byte selector ID (big-endian)
    view.setUint16(SELECTOR_ID_OFFSET, toolCall.selectorId & 0xffff, false);

    // 32-byte parameter hash
    const hashBytes = Buffer.from(toolCall.parameterHash, 'hex');
    bytes.set(hashBytes.subarray(0, 32), PARAM_HASH_OFFSET);

    // 4-byte timestamp delta (seconds since base, big-endian)
    const deltaSeconds = Math.floor((toolCall.resolvedAt - this.baseTimestamp) / 1000);
    view.setUint32(TIMESTAMP_OFFSET, Math.max(0, deltaSeconds) & 0xffffffff, false);

    this.stats.bytesCompressed += RECORD_SIZE;

    // Run pattern detection periodically
    if (this.stats.totalCalls % 10 === 0) {
      this.detectPatterns();
    }

    return {
      bytes,
      summary: `[${toolCall.selectorId}:${toolCall.selector}] ${toolCall.parameterHash.slice(0, 8)}...`,
    };
  }

  /**
   * Decode a binary record back to its constituent parts.
   */
  decode(
    bytes: Uint8Array,
    selectorResolver?: (id: number) => string | undefined
  ): { selectorId: number; parameterHash: string; timestampDelta: number; selector?: string } {
    if (bytes.length < RECORD_SIZE) {
      throw new Error(`Invalid record size: expected ${RECORD_SIZE} bytes, got ${bytes.length}`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const selectorId = view.getUint16(SELECTOR_ID_OFFSET, false);
    const paramHashBytes = bytes.slice(PARAM_HASH_OFFSET, PARAM_HASH_OFFSET + 32);
    const parameterHash = Buffer.from(paramHashBytes).toString('hex');
    const timestampDelta = view.getUint32(TIMESTAMP_OFFSET, false);

    return {
      selectorId,
      parameterHash,
      timestampDelta,
      selector: selectorResolver?.(selectorId),
    };
  }

  /**
   * Detect repeated multi-step patterns in the tool call history.
   * Uses a sliding window approach to find recurring subsequences.
   */
  detectPatterns(): IntentPattern[] {
    const selectors = this.history.map((h) => h.selector);
    const newPatterns: IntentPattern[] = [];

    for (let len = 2; len <= this.config.maxPatternLength; len++) {
      const counts = new Map<string, { selectors: string[]; indices: number[] }>();

      for (let i = 0; i <= selectors.length - len; i++) {
        const subseq = selectors.slice(i, i + len);
        const key = subseq.join('→');
        const existing = counts.get(key);
        if (existing) {
          existing.indices.push(i);
        } else {
          counts.set(key, { selectors: subseq, indices: [i] });
        }
      }

      for (const [key, { selectors: sels, indices }] of counts) {
        if (indices.length >= this.config.patternThreshold) {
          const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
          const compositeSelector = `composite_${sels.join('_')}`;

          const existing = this.patterns.get(id);
          if (existing) {
            existing.occurrences = indices.length;
            existing.lastSeen = Date.now();
          } else {
            const pattern: IntentPattern = {
              id,
              selectors: sels,
              occurrences: indices.length,
              compositeSelector,
              firstSeen: Date.now(),
              lastSeen: Date.now(),
            };
            this.patterns.set(id, pattern);
            newPatterns.push(pattern);
          }
        }
      }
    }

    return newPatterns;
  }

  /**
   * Check if a sequence of selectors matches a known pattern.
   * Returns the composite selector if a match is found.
   */
  matchPattern(selectors: string[]): IntentPattern | undefined {
    const key = selectors.join('→');
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    const pattern = this.patterns.get(id);
    if (pattern) {
      this.stats.patternHits++;
    }
    return pattern;
  }

  /**
   * Encode a batch of tool calls into a single compact buffer.
   */
  encodeBatch(toolCalls: CompressedToolCall[]): Uint8Array {
    const buffer = new Uint8Array(toolCalls.length * RECORD_SIZE);
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      const record = this.encode(call);
      buffer.set(record.bytes, i * RECORD_SIZE);
    }
    return buffer;
  }

  /**
   * Get compression statistics.
   */
  getStats(): CompressionStats {
    const uniqueSelectors = new Set(this.history.map((h) => h.selector)).size;
    return {
      totalCalls: this.stats.totalCalls,
      uniqueSelectors,
      bytesOriginal: this.stats.bytesOriginal,
      bytesCompressed: this.stats.bytesCompressed,
      compressionRatio:
        this.stats.bytesOriginal > 0
          ? 1 - this.stats.bytesCompressed / this.stats.bytesOriginal
          : 0,
      patternsDetected: this.patterns.size,
      patternHits: this.stats.patternHits,
    };
  }

  /**
   * Get all detected patterns, sorted by occurrence count (descending).
   */
  getPatterns(): IntentPattern[] {
    return Array.from(this.patterns.values()).sort((a, b) => b.occurrences - a.occurrences);
  }

  /**
   * Get the fixed record size for binary-encoded tool calls.
   */
  static get recordSize(): number {
    return RECORD_SIZE;
  }
}
