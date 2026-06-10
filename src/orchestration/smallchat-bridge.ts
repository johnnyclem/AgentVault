/**
 * SmallChat Bridge — Core Runtime Integration for AgentVault
 *
 * Wraps SmallChat's message-passing tool compiler to serve as AgentVault's
 * tool dispatch middleware. Provides:
 *
 *   1. Selector interning — maps verbose tool call names to compact IDs
 *   2. LRU resolution cache — avoids re-resolving known intent→tool mappings
 *   3. Superclass fallback — resolves through ToolClass hierarchy
 *   4. Dispatch validation — type-checks parameters before execution
 *
 * Sits between LLM output and MCP client / canister execution:
 *
 *   LLM intent → SmallChatBridge.dispatch() → validated CompressedToolCall → canister
 */

import * as crypto from 'node:crypto';
import {
  type SmallChatToolDefinition,
  type ToolClass,
  type ToolCategory,
  type RiskLevel,
  ALL_TOOL_CLASSES,
  getSuperclassChain,
  findToolClassForSelector,
} from './smallchat-tools.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompressedToolCall {
  /** Interned selector ID (compact numeric representation) */
  selectorId: number;
  /** Original selector string */
  selector: string;
  /** SHA-256 hash of normalized parameters */
  parameterHash: string;
  /** Actual parameters for execution */
  parameters: Record<string, unknown>;
  /** Resolved Candid method name */
  resolvedMethod: string;
  /** Tool category */
  category: ToolCategory;
  /** Risk level of the resolved tool */
  riskLevel: RiskLevel;
  /** Whether this resolution came from cache */
  cached: boolean;
  /** Resolution timestamp */
  resolvedAt: number;
  /** Resolution path (class chain traversed) */
  resolutionPath: string[];
}

export interface SmallChatBridgeConfig {
  /** Max LRU cache entries (default: 256) */
  cacheSize?: number;
  /** Tool classes to register (default: all AgentVault tools) */
  toolClasses?: ToolClass[];
  /** Enable resolution caching (default: true) */
  enableCache?: boolean;
}

export interface DispatchResult {
  success: boolean;
  toolCall?: CompressedToolCall;
  error?: string;
}

export interface BridgeStats {
  totalDispatches: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  registeredSelectors: number;
  registeredClasses: number;
  cacheSize: number;
}

// ---------------------------------------------------------------------------
// LRU Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  toolCall: CompressedToolCall;
  accessedAt: number;
  version: number;
}

class LRUResolutionCache {
  private cache = new Map<string, CacheEntry>();
  private version = 0;

  constructor(private maxSize: number) {}

  get(key: string): CompressedToolCall | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Update access time (LRU touch)
    entry.accessedAt = Date.now();
    return entry.toolCall;
  }

  set(key: string, toolCall: CompressedToolCall): void {
    // Evict LRU entry if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      toolCall,
      accessedAt: Date.now(),
      version: this.version,
    });
  }

  invalidate(): void {
    this.version++;
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Selector Table
// ---------------------------------------------------------------------------

class SelectorTable {
  private selectorToId = new Map<string, number>();
  private idToSelector = new Map<number, string>();
  private nextId = 1;

  intern(selector: string): number {
    const existing = this.selectorToId.get(selector);
    if (existing !== undefined) return existing;

    const id = this.nextId++;
    this.selectorToId.set(selector, id);
    this.idToSelector.set(id, selector);
    return id;
  }

  resolve(id: number): string | undefined {
    return this.idToSelector.get(id);
  }

  getId(selector: string): number | undefined {
    return this.selectorToId.get(selector);
  }

  get size(): number {
    return this.selectorToId.size;
  }

  entries(): Array<[string, number]> {
    return Array.from(this.selectorToId.entries());
  }
}

// ---------------------------------------------------------------------------
// SmallChat Bridge
// ---------------------------------------------------------------------------

export class SmallChatBridge {
  private selectorTable = new SelectorTable();
  private cache: LRUResolutionCache;
  private toolDefinitions: Map<string, SmallChatToolDefinition>;
  private toolClasses: ToolClass[];
  private stats = {
    totalDispatches: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  private cacheEnabled: boolean;

  constructor(config: SmallChatBridgeConfig = {}) {
    const cacheSize = config.cacheSize ?? 256;
    this.cache = new LRUResolutionCache(cacheSize);
    this.toolClasses = config.toolClasses ?? ALL_TOOL_CLASSES;
    this.cacheEnabled = config.enableCache !== false;
    this.toolDefinitions = new Map();

    // Register all tool definitions and intern their selectors
    this.registerToolClasses(this.toolClasses);
  }

  private registerToolClasses(classes: ToolClass[]): void {
    for (const cls of classes) {
      for (const tool of cls.tools) {
        this.selectorTable.intern(tool.selector);
        this.toolDefinitions.set(tool.selector, tool);
      }
    }
  }

  /**
   * Dispatch a tool call intent through the SmallChat resolution pipeline.
   *
   * @param selector - Tool selector string (e.g., 'queueTransaction')
   * @param parameters - Tool parameters
   * @returns Dispatch result with compressed tool call or error
   */
  dispatch(
    selector: string,
    parameters: Record<string, unknown> = {}
  ): DispatchResult {
    this.stats.totalDispatches++;

    // Build cache key from selector + normalized params
    const paramHash = this.hashParameters(parameters);
    const cacheKey = `${selector}:${paramHash}`;

    // Check cache first
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.stats.cacheHits++;
        return {
          success: true,
          toolCall: { ...cached, cached: true, resolvedAt: Date.now() },
        };
      }
    }

    this.stats.cacheMisses++;

    // Resolve through tool class hierarchy
    const resolution = this.resolveSelector(selector);
    if (!resolution) {
      return {
        success: false,
        error: `No tool found for selector '${selector}'. ` +
          `Available selectors: ${Array.from(this.toolDefinitions.keys()).join(', ')}`,
      };
    }

    const { tool, resolutionPath } = resolution;

    // Validate parameters against schema
    const validationError = this.validateParameters(tool, parameters);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // Build compressed tool call
    const selectorId = this.selectorTable.intern(selector);
    const toolCall: CompressedToolCall = {
      selectorId,
      selector,
      parameterHash: paramHash,
      parameters,
      resolvedMethod: tool.candidMethod,
      category: tool.category,
      riskLevel: tool.riskLevel,
      cached: false,
      resolvedAt: Date.now(),
      resolutionPath,
    };

    // Store in cache
    if (this.cacheEnabled) {
      this.cache.set(cacheKey, toolCall);
    }

    return { success: true, toolCall };
  }

  /**
   * Resolve a selector through the ToolClass hierarchy with superclass fallback.
   */
  private resolveSelector(
    selector: string
  ): { tool: SmallChatToolDefinition; resolutionPath: string[] } | undefined {
    // Direct lookup first
    const directTool = this.toolDefinitions.get(selector);
    if (directTool) {
      const owningClass = findToolClassForSelector(selector);
      return {
        tool: directTool,
        resolutionPath: owningClass ? [owningClass.name] : ['direct'],
      };
    }

    // Superclass fallback: try to find a partial match by walking up each class chain
    for (const cls of this.toolClasses) {
      const chain = getSuperclassChain(cls.name);
      for (const className of chain) {
        const classRef = this.toolClasses.find((c) => c.name === className);
        if (!classRef) continue;
        const match = classRef.tools.find(
          (t) => t.selector === selector || t.candidMethod === selector
        );
        if (match) {
          return { tool: match, resolutionPath: chain.slice(0, chain.indexOf(className) + 1) };
        }
      }
    }

    return undefined;
  }

  /**
   * Validate parameters against a tool's schema.
   */
  private validateParameters(
    tool: SmallChatToolDefinition,
    params: Record<string, unknown>
  ): string | undefined {
    for (const [name, schema] of Object.entries(tool.parameters)) {
      if (schema.required && !(name in params)) {
        return `Missing required parameter '${name}' for tool '${tool.selector}'`;
      }

      if (name in params && params[name] !== undefined && params[name] !== null) {
        const value = params[name];
        const typeValid = this.checkType(value, schema.type);
        if (!typeValid) {
          return `Parameter '${name}' for tool '${tool.selector}' expected type '${schema.type}', got '${typeof value}'`;
        }

        if (schema.enum && typeof value === 'string' && !schema.enum.includes(value)) {
          return `Parameter '${name}' for tool '${tool.selector}' must be one of: ${schema.enum.join(', ')}`;
        }
      }
    }

    return undefined;
  }

  private checkType(value: unknown, expectedType: string): boolean {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      default:
        return true;
    }
  }

  /**
   * Hash parameters to a compact SHA-256 string for caching and dedup.
   */
  private hashParameters(params: Record<string, unknown>): string {
    const normalized = JSON.stringify(params, Object.keys(params).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Get a tool definition by selector.
   */
  getToolDefinition(selector: string): SmallChatToolDefinition | undefined {
    return this.toolDefinitions.get(selector);
  }

  /**
   * Get the interned selector ID for a given selector string.
   */
  getSelectorId(selector: string): number | undefined {
    return this.selectorTable.getId(selector);
  }

  /**
   * Resolve a selector ID back to its string.
   */
  resolveId(id: number): string | undefined {
    return this.selectorTable.resolve(id);
  }

  /**
   * Get all interned selector entries.
   */
  getSelectorEntries(): Array<[string, number]> {
    return this.selectorTable.entries();
  }

  /**
   * Generate a compact LLM system prompt header describing available tools.
   * Uses SmallChat's compact format instead of full JSON schemas.
   */
  generateSystemPromptHeader(): string {
    const lines: string[] = [
      '# Available Agent Tools',
      '',
      'Tools are organized by category. Use the selector name to invoke.',
      '',
    ];

    const byCategory = new Map<string, SmallChatToolDefinition[]>();
    for (const tool of this.toolDefinitions.values()) {
      const existing = byCategory.get(tool.category) ?? [];
      existing.push(tool);
      byCategory.set(tool.category, existing);
    }

    for (const [category, tools] of byCategory) {
      lines.push(`## ${category}`);
      for (const tool of tools) {
        const params = Object.entries(tool.parameters)
          .map(([name, schema]) => {
            const req = schema.required ? '' : '?';
            const enumSuffix = schema.enum ? ` (${schema.enum.join('|')})` : '';
            return `${name}${req}: ${schema.type}${enumSuffix}`;
          })
          .join(', ');
        const paramStr = params ? `(${params})` : '()';
        lines.push(`- \`${tool.selector}${paramStr}\` — ${tool.description}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get bridge statistics.
   */
  getStats(): BridgeStats {
    const total = this.stats.totalDispatches;
    return {
      ...this.stats,
      cacheHitRate: total > 0 ? this.stats.cacheHits / total : 0,
      registeredSelectors: this.selectorTable.size,
      registeredClasses: this.toolClasses.length,
      cacheSize: this.cache.size,
    };
  }

  /**
   * Invalidate the resolution cache (e.g., after tool class hot-reload).
   */
  invalidateCache(): void {
    this.cache.invalidate();
  }
}
