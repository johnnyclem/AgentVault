/**
 * AgentVault Wiki — LLM-Maintained Knowledge Base
 *
 * Implements the "LLM Wiki" pattern (Karpathy, 2025):
 *   Raw Sources → LLM Synthesis → Persistent Wiki Pages
 *
 * Three core operations:
 *   Ingest — archive sources, synthesize pages, weave cross-references
 *   Query  — search pages, synthesize answers, file explorations
 *   Lint   — detect contradictions, orphans, staleness, dead references
 *
 * Storage tiers:
 *   Arweave  — immutable raw source archive
 *   WikiStore — mutable, versioned wiki pages (in-memory or canister-backed)
 *   ICP      — durable on-chain persistence
 *
 * Usage:
 *   import { WikiIngestService, WikiQueryService, WikiLintService } from 'agentvault/wiki';
 */

// Store
export { InMemoryWikiStore } from './wiki-store.js';
export type { WikiStore, WikiListFilters } from './wiki-store.js';

// Ingest
export { WikiIngestService } from './ingest.js';
export type { WikiLLMAdapter, SynthesisResult } from './ingest.js';

// Query
export { WikiQueryService } from './query.js';
export type { WikiQueryLLMAdapter } from './query.js';

// Lint
export { WikiLintService } from './lint.js';
export type { WikiLintLLMAdapter } from './lint.js';

// MCP Tools
export { getWikiToolDefinitions, handleWikiToolCall } from './mcp-tools.js';
export type { WikiMCPConfig } from './mcp-tools.js';
